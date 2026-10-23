import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '@autotest/devices';

describe('@autotest/devices scaffold', () => {
  it('resolves through the workspace entrypoint', () => {
    expect(PACKAGE_NAME).toBe('@autotest/devices');
  });
});
