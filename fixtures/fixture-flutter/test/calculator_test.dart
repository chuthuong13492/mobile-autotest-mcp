@Tags(['math'])
library;

import 'package:fixture_flutter/calculator.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers/numbers.dart';

void main() {
  final calc = Calculator();
  test('add returns the sum', () => expect(calc.add(40, 2), answer));
  test('divide truncates', () => expect(calc.divide(7, 2), 3));
  test('divide by zero throws ArgumentError', () => expect(() => calc.divide(1, 0), throwsArgumentError));
}
