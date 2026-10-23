import 'package:flutter_test/flutter_test.dart';
void main() { test('slow for interrupt', () async { await Future<void>.delayed(const Duration(seconds: 60)); }); }
