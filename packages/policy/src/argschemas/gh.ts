/**
 * Argument schema for the GitHub CLI `gh` (GH-001; ADR-0013 update 2026-10-24). AutoTest uses `gh` only to read the
 * user's existing login: `gh auth token --hostname <host>` (the token for API calls) and `gh auth status --hostname
 * <host>` (doctor). Both are read-only `probe` invocations; every other `gh` command is denied, so `gh` can never
 * write to GitHub on AutoTest's behalf — writes go through the API client after P3 authorization.
 */
import type { ArgSchema } from './types.ts';

const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const GH_SCHEMA: ArgSchema = {
  executable: 'gh',
  forbiddenFlags: ['--with-token', '--insecure-storage', '--show-token'],
  forms: [
    {
      id: 'gh.auth_token',
      class: 'probe',
      words: ['auth', 'token'],
      requiredFlags: ['--hostname'],
      flags: [{ name: '--hostname', value: { kind: 'pattern', pattern: HOST } }],
    },
    {
      id: 'gh.auth_status',
      class: 'probe',
      words: ['auth', 'status'],
      requiredFlags: ['--hostname'],
      flags: [{ name: '--hostname', value: { kind: 'pattern', pattern: HOST } }],
    },
  ],
};
