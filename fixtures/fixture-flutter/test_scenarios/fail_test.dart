import 'package:fixture_flutter/calculator.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('add is wrong on purpose', () => expect(Calculator().add(1, 1), 3));
}
