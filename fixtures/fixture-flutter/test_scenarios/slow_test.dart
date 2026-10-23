import 'package:flutter_test/flutter_test.dart';

void main() {
  test('runs for a minute', () async {
    await Future<void>.delayed(const Duration(seconds: 60));
  }, timeout: const Timeout(Duration(minutes: 5)));
}
