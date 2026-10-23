import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '@autotest/analysis';

describe('@autotest/analysis scaffold', () => {
  it('resolves through the workspace entrypoint', () => {
    expect(PACKAGE_NAME).toBe('@autotest/analysis');
  });
});
