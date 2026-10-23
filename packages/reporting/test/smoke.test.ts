import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '@autotest/reporting';

describe('@autotest/reporting scaffold', () => {
  it('resolves through the workspace entrypoint', () => {
    expect(PACKAGE_NAME).toBe('@autotest/reporting');
  });
});
