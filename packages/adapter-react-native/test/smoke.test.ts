import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '@autotest/adapter-react-native';

describe('@autotest/adapter-react-native scaffold', () => {
  it('resolves through the workspace entrypoint', () => {
    expect(PACKAGE_NAME).toBe('@autotest/adapter-react-native');
  });
});
