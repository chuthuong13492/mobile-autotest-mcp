/** Report model, verdict assembly and renderers (RPT-001 – RPT-003). JUnit is rendered by the workflow with the
 * adapter SDK's writer, because `reporting` may depend only on `core` (boundaries.json). */
export const PACKAGE_NAME = '@autotest/reporting' as const;
export * from './model.ts';
export * from './markdown.ts';
export * from './json.ts';
