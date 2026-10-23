import 'package:flutter_test/flutter_test.dart';
import 'package:scratch_app/badge.dart';
void main() {
  testWidgets('badge shows count', (t) async { await t.pumpWidget(const CountBadge(count: 3)); expect(find.text('3'), findsOneWidget); });
  test('unit pass', () => expect(1 + 1, 2));
}
