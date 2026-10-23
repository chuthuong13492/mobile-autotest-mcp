/** Platform adapters shipped with this build (FL-001: Flutter host tests). Shared by the server and its supervisor. */
import type { PlatformAdapter } from '@autotest/adapter-sdk';
import { createFlutterAdapter } from '@autotest/adapter-flutter';

export function builtInAdapters(): PlatformAdapter[] {
  return [createFlutterAdapter()];
}
