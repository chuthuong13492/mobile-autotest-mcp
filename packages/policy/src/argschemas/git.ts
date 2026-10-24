/**
 * Argument schema for `git` (ANL-002 baseline runs). AutoTest uses git only to check out the PR's base commit into a
 * worktree inside the run directory, and to remove it again:
 * - `git rev-parse --verify --quiet <ref>^{commit}` resolves the base ref to a commit (probe);
 * - `git worktree add --detach <runDir>/baseline <sha>` and `git worktree remove --force <runDir>/baseline`;
 * - `git worktree prune` drops records of worktrees that no longer exist.
 *
 * Every form starts with fixed `-c` options: repository hooks never run (`core.hooksPath=/dev/null`), git may not use
 * any transport (`protocol.allow=never`, so nothing is fetched), and Git LFS filters are disabled (no smudge
 * downloads). The ref is a plain name or hex id (no leading '-', no `..`, no `@{`), the commit is a full SHA-1 or
 * SHA-256, and the worktree path is always `baseline` in the run directory.
 */
import type { ArgSchema, CommandForm } from './types.ts';

const SAFE = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.allow=never',
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.process=',
  '-c',
  'filter.lfs.required=false',
] as const;

/** A branch, tag or hex id followed by `^{commit}`; no option-like or revision-range syntax. */
const REF = /^(?!.*\.\.)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}\^\{commit\}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const WORKTREE = /^baseline$/;

const form = (id: string, cls: CommandForm['class'], words: readonly string[], extra: Partial<CommandForm> = {}) =>
  ({ id, class: cls, words: [...SAFE, ...words], flags: [], requiredFlags: [], ...extra }) as CommandForm;

export const GIT_SCHEMA: ArgSchema = {
  executable: 'git',
  forbiddenFlags: ['--exec-path', '--upload-pack', '--receive-pack', '--git-dir', '--work-tree', '--config-env'],
  forms: [
    form('git.rev_parse_commit', 'probe', ['rev-parse', '--verify', '--quiet'], {
      positionals: [{ kind: 'word', pattern: REF }],
    }),
    form('git.worktree_add', 'build_tool', ['worktree', 'add', '--detach'], {
      positionals: [
        { kind: 'runPath', pattern: WORKTREE },
        { kind: 'word', pattern: SHA },
      ],
    }),
    form('git.worktree_remove', 'build_tool', ['worktree', 'remove', '--force'], {
      positionals: [{ kind: 'runPath', pattern: WORKTREE }],
    }),
    form('git.worktree_prune', 'build_tool', ['worktree', 'prune']),
  ],
};
