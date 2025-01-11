import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { R_OK } from 'node:constants';
import path, { basename, isAbsolute, parse } from 'node:path';
import picomatch from 'picomatch';
import { StorageCore } from 'src/cores/storage.core';
import { OnEvent, OnJob } from 'src/decorators';
import {
  CreateLibraryDto,
  LibraryResponseDto,
  mapLibrary,
  UpdateLibraryDto,
  ValidateLibraryDto,
  ValidateLibraryImportPathResponseDto,
  ValidateLibraryResponseDto,
} from 'src/dtos/library.dto';
import { AssetEntity } from 'src/entities/asset.entity';
import { LibraryEntity } from 'src/entities/library.entity';
import { AssetStatus, AssetType, ImmichWorker } from 'src/enum';
import { AssetCreate } from 'src/interfaces/asset.interface';
import { DatabaseLock } from 'src/interfaces/database.interface';
import { ArgOf } from 'src/interfaces/event.interface';
import { JobName, JobOf, JOBS_LIBRARY_PAGINATION_SIZE, JobStatus, QueueName } from 'src/interfaces/job.interface';
import { AssetSyncResult } from 'src/interfaces/library.interface';
import { BaseService } from 'src/services/base.service';
import { mimeTypes } from 'src/utils/mime-types';
import { handlePromiseError } from 'src/utils/misc';
import { usePagination } from 'src/utils/pagination';

@Injectable()
export class LibraryService extends BaseService {
  private watchLibraries = false;
  private lock = false;
  private watchers: Record<string, () => Promise<void>> = {};

  @OnEvent({ name: 'config.init', workers: [ImmichWorker.MICROSERVICES] })
  async onConfigInit({
    newConfig: {
      library: { watch, scan },
    },
  }: ArgOf<'config.init'>) {
    // This ensures that library watching only occurs in one microservice
    this.lock = await this.databaseRepository.tryLock(DatabaseLock.Library);

    this.watchLibraries = this.lock && watch.enabled;

    if (this.lock) {
      this.cronRepository.create({
        name: 'libraryScan',
        expression: scan.cronExpression,
        onTick: () =>
          handlePromiseError(this.jobRepository.queue({ name: JobName.LIBRARY_QUEUE_SYNC_ALL }), this.logger),
        start: scan.enabled,
      });
    }

    if (this.watchLibraries) {
      await this.watchAll();
    }
  }

  @OnEvent({ name: 'config.update', server: true })
  async onConfigUpdate({ newConfig: { library } }: ArgOf<'config.update'>) {
    if (!this.lock) {
      return;
    }

    this.cronRepository.update({
      name: 'libraryScan',
      expression: library.scan.cronExpression,
      start: library.scan.enabled,
    });

    if (library.watch.enabled !== this.watchLibraries) {
      // Watch configuration changed, update accordingly
      this.watchLibraries = library.watch.enabled;
      await (this.watchLibraries ? this.watchAll() : this.unwatchAll());
    }
  }

  private async watch(id: string): Promise<boolean> {
    if (!this.watchLibraries) {
      return false;
    }

    const library = await this.findOrFail(id);
    if (library.importPaths.length === 0) {
      return false;
    }

    await this.unwatch(id);

    this.logger.log(`Starting to watch library ${library.id} with import path(s) ${library.importPaths}`);

    const matcher = picomatch(`**/*{${mimeTypes.getSupportedFileExtensions().join(',')}}`, {
      nocase: true,
      ignore: library.exclusionPatterns,
    });

    let _resolve: () => void;
    const ready$ = new Promise<void>((resolve) => (_resolve = resolve));

    const handler = async (event: string, path: string) => {
      if (matcher(path)) {
        this.logger.debug(`File ${event} event received for ${path} in library ${library.id}}`);
        await this.jobRepository.queue({
          name: JobName.LIBRARY_SYNC_FILES,
          data: { libraryId: library.id, ownerId: library.ownerId, assetPaths: [path] },
        });
      } else {
        this.logger.verbose(`Ignoring file ${event} event for ${path} in library ${library.id}`);
      }
    };

    this.watchers[id] = this.storageRepository.watch(
      library.importPaths,
      {
        usePolling: false,
        ignoreInitial: true,
      },
      {
        onReady: () => _resolve(),
        onAdd: (path) => {
          return handlePromiseError(handler('add', path), this.logger);
        },
        onChange: (path) => {
          return handlePromiseError(handler('change', path), this.logger);
        },
        onUnlink: (path) => {
          return handlePromiseError(handler('delete', path), this.logger);
        },
        onError: (error) => {
          this.logger.error(`Library watcher for library ${library.id} encountered error: ${error}`);
        },
      },
    );

    // Wait for the watcher to initialize before returning
    await ready$;

    return true;
  }

  async unwatch(id: string) {
    if (this.watchers[id]) {
      await this.watchers[id]();
      delete this.watchers[id];
    }
  }

  @OnEvent({ name: 'app.shutdown' })
  async onShutdown() {
    await this.unwatchAll();
  }

  private async unwatchAll() {
    if (!this.lock) {
      return false;
    }

    for (const id in this.watchers) {
      await this.unwatch(id);
    }
  }

  async watchAll() {
    if (!this.lock) {
      return false;
    }

    const libraries = await this.libraryRepository.getAll(false);
    for (const library of libraries) {
      await this.watch(library.id);
    }
  }

  async getAssetCount(id: string): Promise<number> {
    const count = await this.assetRepository.getAssetCount({ libraryId: id });
    if (count == undefined) {
      throw new InternalServerErrorException(`Failed to get asset count for library ${id}`);
    }
    return count;
  }

  async get(id: string): Promise<LibraryResponseDto> {
    const library = await this.findOrFail(id);
    return mapLibrary(library);
  }

  async getAll(): Promise<LibraryResponseDto[]> {
    const libraries = await this.libraryRepository.getAll(false);
    return libraries.map((library) => mapLibrary(library));
  }

  @OnJob({ name: JobName.LIBRARY_QUEUE_CLEANUP, queue: QueueName.LIBRARY })
  async handleQueueCleanup(): Promise<JobStatus> {
    this.logger.debug('Cleaning up any pending library deletions');
    const pendingDeletion = await this.libraryRepository.getAllDeleted();
    await this.jobRepository.queueAll(
      pendingDeletion.map((libraryToDelete) => ({ name: JobName.LIBRARY_DELETE, data: { id: libraryToDelete.id } })),
    );
    return JobStatus.SUCCESS;
  }

  async create(dto: CreateLibraryDto): Promise<LibraryResponseDto> {
    const library = await this.libraryRepository.create({
      ownerId: dto.ownerId,
      name: dto.name ?? 'New External Library',
      importPaths: dto.importPaths ?? [],
      exclusionPatterns: dto.exclusionPatterns ?? ['**/@eaDir/**', '**/._*'],
    });
    return mapLibrary(library);
  }

  @OnJob({ name: JobName.LIBRARY_SYNC_FILES, queue: QueueName.LIBRARY })
  async handleSyncFiles(job: JobOf<JobName.LIBRARY_SYNC_FILES>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.libraryId);
    if (!library) {
      // We need to check if the library still exists as it could have been deleted after the scan was queued
      this.logger.debug(`Library ${job.libraryId} not found, skipping file import`);
      return JobStatus.FAILED;
    }

    const assetImports = job.assetPaths.map((assetPath) => this.processEntity(assetPath, job.ownerId, job.libraryId));

    const assetIds: string[] = [];

    // Due to a typeorm limitation we must batch the inserts
    const batchSize = 2000;
    for (let i = 0; i < assetImports.length; i += batchSize) {
      const batch = assetImports.slice(i, i + batchSize);
      const batchIds = await this.assetRepository.createAll(batch).then((assets) => assets.map((asset) => asset.id));
      assetIds.push(...batchIds);
    }

    let progressMessage = '';

    if (job.progressCounter && job.totalAssets) {
      progressMessage = `(${job.progressCounter} of ${job.totalAssets}) `;
    } else {
      progressMessage = `(${job.progressCounter} done so far) `;
    }

    this.logger.log(`Imported ${assetIds.length} ${progressMessage}file(s) into library ${job.libraryId}`);

    await this.queuePostSyncJobs(assetIds);

    return JobStatus.SUCCESS;
  }

  private async validateImportPath(importPath: string): Promise<ValidateLibraryImportPathResponseDto> {
    const validation = new ValidateLibraryImportPathResponseDto();
    validation.importPath = importPath;

    if (StorageCore.isImmichPath(importPath)) {
      validation.message = 'Cannot use media upload folder for external libraries';
      return validation;
    }

    if (!isAbsolute(importPath)) {
      validation.message = `Import path must be absolute, try ${path.resolve(importPath)}`;
      return validation;
    }

    try {
      const stat = await this.storageRepository.stat(importPath);
      if (!stat.isDirectory()) {
        validation.message = 'Not a directory';
        return validation;
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        validation.message = 'Path does not exist (ENOENT)';
        return validation;
      }
      validation.message = String(error);
      return validation;
    }

    const access = await this.storageRepository.checkFileExists(importPath, R_OK);

    if (!access) {
      validation.message = 'Lacking read permission for folder';
      return validation;
    }

    validation.isValid = true;
    return validation;
  }

  async validate(id: string, dto: ValidateLibraryDto): Promise<ValidateLibraryResponseDto> {
    const importPaths = await Promise.all(
      (dto.importPaths || []).map((importPath) => this.validateImportPath(importPath)),
    );
    return { importPaths };
  }

  async update(id: string, dto: UpdateLibraryDto): Promise<LibraryResponseDto> {
    await this.findOrFail(id);

    if (dto.importPaths) {
      const validation = await this.validate(id, { importPaths: dto.importPaths });
      if (validation.importPaths) {
        for (const path of validation.importPaths) {
          if (!path.isValid) {
            throw new BadRequestException(`Invalid import path: ${path.message}`);
          }
        }
      }
    }

    const library = await this.libraryRepository.update({ id, ...dto });
    return mapLibrary(library);
  }

  async delete(id: string) {
    await this.findOrFail(id);

    if (this.watchLibraries) {
      await this.unwatch(id);
    }

    await this.libraryRepository.softDelete(id);
    await this.jobRepository.queue({ name: JobName.LIBRARY_DELETE, data: { id } });
  }

  @OnJob({ name: JobName.LIBRARY_DELETE, queue: QueueName.LIBRARY })
  async handleDeleteLibrary(job: JobOf<JobName.LIBRARY_DELETE>): Promise<JobStatus> {
    const libraryId = job.id;

    const assetPagination = usePagination(JOBS_LIBRARY_PAGINATION_SIZE, (pagination) =>
      this.assetRepository.getAll(pagination, { libraryId, withDeleted: true }),
    );

    let assetsFound = false;

    this.logger.debug(`Will delete all assets in library ${libraryId}`);
    for await (const assets of assetPagination) {
      if (assets.length > 0) {
        assetsFound = true;
      }

      this.logger.debug(`Queueing deletion of ${assets.length} asset(s) in library ${libraryId}`);
      await this.jobRepository.queueAll(
        assets.map((asset) => ({
          name: JobName.ASSET_DELETION,
          data: {
            id: asset.id,
            deleteOnDisk: false,
          },
        })),
      );
    }

    if (!assetsFound) {
      this.logger.log(`Deleting library ${libraryId}`);
      await this.libraryRepository.delete(libraryId);
    }
    return JobStatus.SUCCESS;
  }

  private processEntity(filePath: string, ownerId: string, libraryId: string): AssetCreate {
    const assetPath = path.normalize(filePath);

    // This date will be set until metadata extraction runs
    const datePlaceholder = new Date('1900-01-01');

    return {
      ownerId,
      libraryId,
      checksum: this.cryptoRepository.hashSha1(`path:${assetPath}`),
      originalPath: assetPath,

      // TODO: device asset id is deprecated, remove it
      deviceAssetId: `${basename(assetPath)}`.replaceAll(/\s+/g, ''),
      deviceId: 'Library Import',
      fileCreatedAt: datePlaceholder,
      fileModifiedAt: datePlaceholder,
      localDateTime: datePlaceholder,
      type: mimeTypes.isVideo(assetPath) ? AssetType.VIDEO : AssetType.IMAGE,
      originalFileName: parse(assetPath).base,
      isExternal: true,
    };
  }

  async queuePostSyncJobs(assetIds: string[]) {
    this.logger.debug(`Queuing metadata extraction for ${assetIds.length} asset(s)`);

    // We queue a sidecar discovery which, in turn, queues metadata extraction
    await this.jobRepository.queueAll(
      assetIds.map((assetId) => ({
        name: JobName.SIDECAR_DISCOVERY,
        data: { id: assetId, source: 'upload' },
      })),
    );
  }

  async queueScan(id: string) {
    await this.findOrFail(id);

    this.logger.log(`Starting to scan library ${id}`);

    await this.jobRepository.queue({
      name: JobName.LIBRARY_QUEUE_SYNC_FILES,
      data: {
        id,
      },
    });

    await this.jobRepository.queue({ name: JobName.LIBRARY_QUEUE_SYNC_ASSETS, data: { id } });
  }

  @OnJob({ name: JobName.LIBRARY_QUEUE_SYNC_ALL, queue: QueueName.LIBRARY })
  async handleQueueSyncAll(): Promise<JobStatus> {
    this.logger.log(`Initiating scan of all external libraries`);

    await this.jobRepository.queue({ name: JobName.LIBRARY_QUEUE_CLEANUP, data: {} });

    const libraries = await this.libraryRepository.getAll(true);

    await this.jobRepository.queueAll(
      libraries.map((library) => ({
        name: JobName.LIBRARY_QUEUE_SYNC_FILES,
        data: {
          id: library.id,
        },
      })),
    );
    await this.jobRepository.queueAll(
      libraries.map((library) => ({
        name: JobName.LIBRARY_QUEUE_SYNC_ASSETS,
        data: {
          id: library.id,
        },
      })),
    );

    return JobStatus.SUCCESS;
  }

  @OnJob({ name: JobName.LIBRARY_SYNC_ASSETS, queue: QueueName.LIBRARY })
  async handleSyncAssets(job: JobOf<JobName.LIBRARY_SYNC_ASSETS>): Promise<JobStatus> {
    const assets = await this.assetRepository.getByIds(job.assetIds);

    const assetIdsToOffline: string[] = [];
    const assetIdsToOnline: string[] = [];
    const assetIdsToUpdate: string[] = [];

    this.logger.debug(`Checking batch of ${assets.length} existing asset(s) in library ${job.library.id}`);

    for (const asset of assets) {
      const action = await this.checkExistingAsset(asset, job.library);
      switch (action) {
        case AssetSyncResult.OFFLINE: {
          assetIdsToOffline.push(asset.id);
          break;
        }
        case AssetSyncResult.ONLINE: {
          assetIdsToOffline.push(asset.id);
          break;
        }
        case AssetSyncResult.UPDATE: {
          assetIdsToUpdate.push(asset.id);
          break;
        }
      }
    }

    let progressMessage = '';

    if (assetIdsToOffline.length > 0) {
      await this.assetRepository.updateAll(assetIdsToOffline, {
        isOffline: true,
        status: AssetStatus.TRASHED,
        deletedAt: new Date(),
      });

      if (progressMessage) {
        progressMessage + ', ';
      }
      progressMessage += `${assetIdsToOffline.length} offlined`;
    }

    if (assetIdsToOnline.length > 0) {
      //TODO: When we have asset status, we need to leave deletedAt as is when status is trashed
      await this.assetRepository.updateAll(assetIdsToOnline, {
        isOffline: false,
        status: AssetStatus.ACTIVE,
        deletedAt: null,
      });
      await this.queuePostSyncJobs(assetIdsToOnline);

      if (progressMessage) {
        progressMessage + ', ';
      }

      progressMessage += `${assetIdsToOnline.length} onlined`;
    }

    if (assetIdsToUpdate.length > 0) {
      //TODO: When we have asset status, we need to leave deletedAt as is when status is trashed
      await this.queuePostSyncJobs(assetIdsToUpdate);

      if (progressMessage) {
        progressMessage + ', ';
      }

      progressMessage += `${assetIdsToUpdate.length} updated`;
    }

    const remainingCount = assets.length - assetIdsToOffline.length - assetIdsToUpdate.length - assetIdsToOnline.length;

    if (remainingCount) {
      if (progressMessage) {
        progressMessage + ', ';
      }

      progressMessage += `${remainingCount} unchanged`;
    }

    let cumulativeProgressMessage = '';

    if (job.progressCounter && job.totalAssets) {
      const cumulativePercentage = ((100 * job.progressCounter) / job.totalAssets).toFixed(1);

      cumulativeProgressMessage = `(Total progress: ${job.progressCounter} of ${job.totalAssets}, ${cumulativePercentage} %) `;
    }

    this.logger.log(
      `Checked existing asset(s): ${progressMessage} of current batch of ${assets.length} ${cumulativeProgressMessage}in library ${job.library.id}.`,
    );

    return JobStatus.SUCCESS;
  }

  private async checkOfflineAsset(asset: AssetEntity, library: LibraryEntity): Promise<boolean> {
    if (!asset.libraryId) {
      return false;
    }

    if (!library) {
      return false;
    }

    const isInImportPath = library.importPaths.find((path) => asset.originalPath.startsWith(path));
    if (!isInImportPath) {
      return false;
    }

    const isExcluded = library.exclusionPatterns.some((pattern) => picomatch.isMatch(asset.originalPath, pattern));
    if (isExcluded) {
      return false;
    }

    return true;
  }

  private async checkExistingAsset(asset: AssetEntity, library: LibraryEntity): Promise<AssetSyncResult> {
    if (!asset) {
      return AssetSyncResult.DO_NOTHING;
    }

    let stat;
    try {
      stat = await this.storageRepository.stat(asset.originalPath);
    } catch {
      if (asset.isOffline) {
        return AssetSyncResult.DO_NOTHING;
      }

      this.logger.debug(
        `Asset is no longer on disk or is inaccessible because of permissions, moving to trash: ${asset.originalPath}`,
      );
      return AssetSyncResult.OFFLINE;
    }

    const mtime = stat.mtime;
    const isAssetTimeUpdated = mtime.toISOString() !== asset.fileModifiedAt.toISOString();

    let shouldAssetGoOnline = false;

    if (asset.isOffline && asset.status != AssetStatus.DELETED) {
      // Only perform the expensive check if the asset is offline

      // TODO: give more feedback on why asset was onlined
      shouldAssetGoOnline = await this.checkOfflineAsset(asset, library);

      if (shouldAssetGoOnline) {
        this.logger.debug(`Asset is back online: ${asset.originalPath}`);

        return AssetSyncResult.ONLINE;
      } else {
        this.logger.debug(`Asset is still offline: ${asset.originalPath}`);

        return AssetSyncResult.DO_NOTHING;
      }
    }

    if (isAssetTimeUpdated) {
      this.logger.verbose(
        `Asset ${asset.originalPath} modification time changed from ${asset.fileModifiedAt.toISOString()} to ${mtime.toISOString()}, queuing metadata extraction`,
      );

      return AssetSyncResult.UPDATE;
    }

    return AssetSyncResult.DO_NOTHING;
  }

  @OnJob({ name: JobName.LIBRARY_QUEUE_SYNC_FILES, queue: QueueName.LIBRARY })
  async handleQueueSyncFiles(job: JobOf<JobName.LIBRARY_QUEUE_SYNC_FILES>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.id);
    if (!library) {
      this.logger.debug(`Library ${job.id} not found, skipping refresh`);
      return JobStatus.SKIPPED;
    }

    this.logger.debug(`Validating import paths for library ${library.id}...`);

    const validImportPaths: string[] = [];

    for (const importPath of library.importPaths) {
      const validation = await this.validateImportPath(importPath);
      if (validation.isValid) {
        validImportPaths.push(path.normalize(importPath));
      } else {
        this.logger.warn(`Skipping invalid import path: ${importPath}. Reason: ${validation.message}`);
      }
    }

    if (validImportPaths.length === 0) {
      this.logger.warn(`No valid import paths found for library ${library.id}`);

      return JobStatus.SKIPPED;
    }

    let assetsOnDiskCount = 0;

    const pathsOnDisk = this.storageRepository.walk({
      pathsToCrawl: validImportPaths,
      includeHidden: false,
      exclusionPatterns: library.exclusionPatterns,
      take: JOBS_LIBRARY_PAGINATION_SIZE,
    });

    let importCount = 0;
    let crawlCount = 0;

    this.logger.log(`Starting disk crawl of ${validImportPaths.length} import path(s) for library ${library.id}...`);

    for await (const pathBatch of pathsOnDisk) {
      crawlCount += pathBatch.length;
      const newPaths = await this.assetRepository.getNewPaths(library.id, pathBatch);

      if (newPaths.length > 0) {
        importCount += newPaths.length;

        await this.jobRepository.queue({
          name: JobName.LIBRARY_SYNC_FILES,
          data: {
            libraryId: library.id,
            ownerId: library.ownerId,
            assetPaths: newPaths,
            progressCounter: crawlCount,
            totalAssets: assetsOnDiskCount,
          },
        });
        this.logger.log(
          `Crawled ${crawlCount} file(s) so far: ${newPaths.length} of current batch of ${pathBatch.length} will be imported to library ${library.id}...`,
        );
      } else {
        this.logger.log(
          `Crawled ${crawlCount} file(s) so far: All ${pathBatch.length} of current batch already in library ${library.id}...`,
        );
      }
    }

    if (crawlCount === 0) {
      this.logger.log(`No files found on disk for library ${library.id}`);
    } else if (importCount > 0 && importCount === crawlCount) {
      this.logger.log(`Finished crawling and queueing ${crawlCount} file(s) for import for library ${library.id}`);
    } else if (importCount > 0) {
      this.logger.log(
        `Finished crawling ${crawlCount} file(s) of which ${importCount} file(s) are queued for import for library ${library.id}`,
      );
    } else {
      this.logger.log(`All ${crawlCount} file(s) on disk are already in library ${library.id}`);
    }

    await this.libraryRepository.update({ id: job.id, refreshedAt: new Date() });

    return JobStatus.SUCCESS;
  }

  @OnJob({ name: JobName.LIBRARY_QUEUE_SYNC_ASSETS, queue: QueueName.LIBRARY })
  async handleQueueSyncAssets(job: JobOf<JobName.LIBRARY_QUEUE_SYNC_ASSETS>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.id);
    if (!library) {
      return JobStatus.SKIPPED;
    }

    const assetCount = await this.assetRepository.getAssetCount({ libraryId: job.id, withDeleted: true });

    if (!assetCount) {
      this.logger.log(`Library ${library.id} is empty, no need to check assets`);
      return JobStatus.SUCCESS;
    }

    this.logger.log(
      `Checking ${assetCount} asset(s) against import paths and exclusion patterns in library ${library.id}...`,
    );

    const offlineResult = await this.assetRepository.updateOffline(library);

    const affectedAssetCount = offlineResult.affected;
    if (affectedAssetCount === undefined) {
      this.logger.error(`Unknown error occurred when updating offline status in ${library.id}`);
      return JobStatus.FAILED;
    }

    if (affectedAssetCount === assetCount) {
      this.logger.log(
        `All ${assetCount} asset(s) were offlined due to import paths and/or exclusion pattern(s) in ${library.id}`,
      );

      return JobStatus.SUCCESS;
    } else if (affectedAssetCount == 0) {
      this.logger.log(`No assets were offlined due to import paths and/or exclusion pattern(s) in ${library.id} `);
    } else {
      this.logger.log(
        `${offlineResult.affected} asset(s) out of ${assetCount} were offlined due to import paths and/or exclusion pattern(s) in library ${library.id}`,
      );
    }

    this.logger.log(`Scanning library ${library.id} for assets missing from disk...`);

    const existingAssets = usePagination(JOBS_LIBRARY_PAGINATION_SIZE, (pagination) =>
      this.assetRepository.getAllInLibrary(pagination, job.id),
    );

    let currentAssetCount = 0;
    for await (const assets of existingAssets) {
      currentAssetCount += assets.length;

      await this.jobRepository.queue({
        name: JobName.LIBRARY_SYNC_ASSETS,
        data: {
          library,
          assetIds: assets.map((asset) => asset.id),
          progressCounter: currentAssetCount,
          totalAssets: assetCount,
        },
      });

      const completePercentage = ((100 * currentAssetCount) / assetCount).toFixed(1);

      this.logger.log(
        `Queued check of ${currentAssetCount} of ${assetCount} (${completePercentage} %) existing asset(s) so far in library ${library.id}`,
      );
    }

    if (currentAssetCount) {
      this.logger.log(`Finished queuing ${currentAssetCount} asset check(s) for library ${library.id}`);
    }

    return JobStatus.SUCCESS;
  }

  private async findOrFail(id: string) {
    const library = await this.libraryRepository.get(id);
    if (!library) {
      throw new BadRequestException('Library not found');
    }
    return library;
  }
}
