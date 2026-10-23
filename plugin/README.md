# Claude Code plugin (SKL-001)

This folder is the plugin skeleton. The release build (`pnpm release:pack`) assembles the full plugin into
`release/out/package/plugin/` by adding `skills/pr-mobile-autotest/` from the repository root, so the Skill text
exists in one place only.

- `.claude-plugin/plugin.json`: the manifest (`claude plugin validate` checks it in `test/skill/skill.test.ts`).
- `.mcp.json`: starts `autotest-mcp` from `PATH`. That requires the installed package's bin directory on `PATH` and
  Node 24+ as the `node` on `PATH`. `autotest setup` is the recommended path instead: it registers the server with
  the absolute Node path and copies the Skill to `~/.claude/skills`.
