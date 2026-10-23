import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '@autotest/github';

describe('@autotest/github scaffold', () => {
  it('resolves through the workspace entrypoint', () => {
    expect(PACKAGE_NAME).toBe('@autotest/github');
  });
});
