/** GitHub client and publisher for github.com (GH-001 – GH-004), authenticated by an injected token provider. */
export const PACKAGE_NAME = '@autotest/github' as const;
export * from './client.ts';
export * from './pr.ts';
export * from './publish.ts';
