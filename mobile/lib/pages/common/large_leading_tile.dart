import 'package:flutter/material.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';

class LargeLeadingTile extends StatelessWidget {
  const LargeLeadingTile({
    super.key,
    required this.leading,
    required this.onTap,
    required this.title,
    this.subtitle,
    this.leadingPadding = const EdgeInsets.symmetric(
      vertical: 8,
      horizontal: 16.0,
    ),
    this.borderRadius = 20.0,
    this.trailing,
    this.selected = false,
  });

  final Widget leading;
  final VoidCallback onTap;
  final Widget title;
  final Widget? subtitle;
  final EdgeInsetsGeometry leadingPadding;
  final double borderRadius;
  final Widget? trailing;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(borderRadius),
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          color: selected
              ? Theme.of(context).primaryColor.withAlpha(30)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(borderRadius),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Padding(
              padding: leadingPadding,
              child: leading,
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: context.width * 0.6,
                    child: title,
                  ),
                  subtitle ?? const SizedBox.shrink(),
                ],
              ),
            ),
            if (trailing != null) trailing!,
          ],
        ),
      ),
    );
  }
}
