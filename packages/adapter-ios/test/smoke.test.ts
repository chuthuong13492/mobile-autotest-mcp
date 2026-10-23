import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '@autotest/adapter-ios';

describe('@autotest/adapter-ios scaffold', () => {
  it('resolves through the workspace entrypoint', () => {
    expect(PACKAGE_NAME).toBe('@autotest/adapter-ios');
  });
});
