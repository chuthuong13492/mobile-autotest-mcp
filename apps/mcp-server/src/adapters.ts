/** Platform adapters shipped with this build (Flutter, native iOS, native Android, React Native, Appium). Shared by the server and its supervisor. */
import type { PlatformAdapter } from '@autotest/adapter-sdk';
import { createFlutterAdapter } from '@autotest/adapter-flutter';
import { createIosAdapter } from '@autotest/adapter-ios';
import { createAndroidAdapter } from '@autotest/adapter-android';
import { createReactNativeAdapter } from '@autotest/adapter-react-native';
import { createAppiumAdapter } from '@autotest/adapter-appium';

export function builtInAdapters(): PlatformAdapter[] {
  return [
    createFlutterAdapter(),
    createIosAdapter(),
    createAndroidAdapter(),
    createReactNativeAdapter(),
    createAppiumAdapter(),
  ];
}
