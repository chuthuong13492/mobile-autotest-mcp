/** Platform adapters shipped with this build (Flutter, native iOS). Shared by the server and its supervisor. */
import type { PlatformAdapter } from '@autotest/adapter-sdk';
import { createFlutterAdapter } from '@autotest/adapter-flutter';
import { createIosAdapter } from '@autotest/adapter-ios';

export function builtInAdapters(): PlatformAdapter[] {
  return [createFlutterAdapter(), createIosAdapter()];
}
