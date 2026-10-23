import 'package:flutter/widgets.dart';
class CountBadge extends StatelessWidget {
  const CountBadge({super.key, required this.count});
  final int count;
  @override
  Widget build(BuildContext context) => count > 0
      ? Directionality(textDirection: TextDirection.ltr, child: Text('$count'))
      : const SizedBox.shrink();
}
