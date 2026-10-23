import 'package:fixture_flutter/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('tapping increment shows Count: 1', (tester) async {
    await tester.pumpWidget(const CounterApp());
    expect(find.text('Count: 0'), findsOneWidget);
    await tester.tap(find.byTooltip('Increment'));
    await tester.pump();
    expect(find.text('Count: 1'), findsOneWidget);
  });
}
