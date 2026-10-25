import 'package:fixture_flutter/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

/// Runs on a simulator or an emulator (FL-006): the counter app on a real device engine.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('tapping increment shows Count: 1 on the device', (tester) async {
    await tester.pumpWidget(const CounterApp());
    await tester.tap(find.byTooltip('Increment'));
    await tester.pumpAndSettle();
    expect(find.text('Count: 1'), findsOneWidget);
  });

  testWidgets('the count is wrong on purpose', (tester) async {
    await tester.pumpWidget(const CounterApp());
    expect(find.text('Count: 5'), findsOneWidget);
  });
}
