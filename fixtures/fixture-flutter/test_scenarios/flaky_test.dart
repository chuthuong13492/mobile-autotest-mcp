import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Fails on the first attempt of a run and passes afterwards: AutoTest gives each run its own TMPDIR.
void main() {
  test('passes on the second attempt', () {
    final marker = File('${Platform.environment['TMPDIR'] ?? Directory.systemTemp.path}/autotest_fixture_flaky');
    if (!marker.existsSync()) {
      marker.writeAsStringSync('attempt 1');
      fail('first attempt fails on purpose');
    }
  });
}
