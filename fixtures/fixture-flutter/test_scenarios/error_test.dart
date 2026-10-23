import 'package:fixture_flutter/calculator.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('divide by zero is not caught', () => Calculator().divide(1, 0));
}
