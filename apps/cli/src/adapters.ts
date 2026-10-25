/**
 * Platform adapters shipped with this build. The same list as the server app's `builtInAdapters` (apps may not
 * import each other); `test/adapters/flutter.test.ts` checks that the two lists stay equal.
 */
import { createAdapterRegistry, type AdapterRegistry, type PlatformAdapter } from '@autotest/adapter-sdk';
import { createFlutterAdapter } from '@autotest/adapter-flutter';
import { createIosAdapter } from '@autotest/adapter-ios';
import { createAndroidAdapter } from '@autotest/adapter-android';

export function cliAdapters(): PlatformAdapter[] {
  return [createFlutterAdapter(), createIosAdapter(), createAndroidAdapter()];
}

export const cliRegistry = (): AdapterRegistry => createAdapterRegistry(cliAdapters());
