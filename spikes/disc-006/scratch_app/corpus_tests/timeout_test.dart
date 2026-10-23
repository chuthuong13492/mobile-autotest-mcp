import 'package:flutter_test/flutter_test.dart';
void main() { test('hangs', () async { await Future<void>.delayed(const Duration(seconds: 30)); }); }
