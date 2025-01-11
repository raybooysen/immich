-- NOTE: This file is auto generated by ./sql-generator

-- SessionRepository.search
select
  *
from
  "sessions"
where
  "sessions"."updatedAt" <= $1

-- SessionRepository.getByToken
select
  "sessions".*,
  to_json("user") as "user"
from
  "sessions"
  inner join lateral (
    select
      "id",
      "email",
      "createdAt",
      "profileImagePath",
      "isAdmin",
      "shouldChangePassword",
      "deletedAt",
      "oauthId",
      "updatedAt",
      "storageLabel",
      "name",
      "quotaSizeInBytes",
      "quotaUsageInBytes",
      "status",
      "profileChangedAt",
      (
        select
          array_agg("user_metadata") as "metadata"
        from
          "user_metadata"
        where
          "users"."id" = "user_metadata"."userId"
      ) as "metadata"
    from
      "users"
    where
      "users"."id" = "sessions"."userId"
      and "users"."deletedAt" is null
  ) as "user" on true
where
  "sessions"."token" = $1

-- SessionRepository.getByUserId
select
  "sessions".*,
  to_json("user") as "user"
from
  "sessions"
  inner join lateral (
    select
      "id",
      "email",
      "createdAt",
      "profileImagePath",
      "isAdmin",
      "shouldChangePassword",
      "deletedAt",
      "oauthId",
      "updatedAt",
      "storageLabel",
      "name",
      "quotaSizeInBytes",
      "quotaUsageInBytes",
      "status",
      "profileChangedAt",
      (
        select
          array_agg("user_metadata") as "metadata"
        from
          "user_metadata"
        where
          "users"."id" = "user_metadata"."userId"
      ) as "metadata"
    from
      "users"
    where
      "users"."id" = "sessions"."userId"
      and "users"."deletedAt" is null
  ) as "user" on true
where
  "sessions"."userId" = $1
order by
  "sessions"."updatedAt" desc,
  "sessions"."createdAt" desc

-- SessionRepository.delete
DELETE FROM "sessions"
WHERE
  "id" = $1
