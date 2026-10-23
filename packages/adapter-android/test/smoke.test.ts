import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '@autotest/adapter-android';

describe('@autotest/adapter-android scaffold', () => {
  it('resolves through the workspace entrypoint', () => {
    expect(PACKAGE_NAME).toBe('@autotest/adapter-android');
  });
});
