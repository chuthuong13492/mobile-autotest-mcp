import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('ignores SIGTERM', () async {
    // Listening replaces the default handler, so SIGTERM no longer stops this process.
    final sub = ProcessSignal.sigterm.watch().listen((_) {});
    await Future<void>.delayed(const Duration(seconds: 60));
    await sub.cancel();
  }, timeout: const Timeout(Duration(minutes: 5)));
}
