/** Platform adapters shipped with this build (Flutter, native iOS, native Android). Shared by the server and its supervisor. */
import type { PlatformAdapter } from '@autotest/adapter-sdk';
import { createFlutterAdapter } from '@autotest/adapter-flutter';
import { createIosAdapter } from '@autotest/adapter-ios';
import { createAndroidAdapter } from '@autotest/adapter-android';

export function builtInAdapters(): PlatformAdapter[] {
  return [createFlutterAdapter(), createIosAdapter(), createAndroidAdapter()];
}
