import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '@autotest/evidence';

describe('@autotest/evidence scaffold', () => {
  it('resolves through the workspace entrypoint', () => {
    expect(PACKAGE_NAME).toBe('@autotest/evidence');
  });
});
