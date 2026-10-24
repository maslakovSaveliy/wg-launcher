# CLAUDE.md

@AGENTS.md
@MEMORY.md

## Claude Code specifics

- Skills flow: `brainstorming` → `writing-plans` → `subagent-driven-development` (the owner's chosen way of working).
  Use `test-driven-development` once code exists, `systematic-debugging` on any failure, and
  `verification-before-completion` before claiming anything is done.
- Library docs: look up the current API in context7 (or the official docs) before using a library, and check versions
  with `npm view`. Training data may be stale.
- Plans live in `docs/plans/` as `YYYY-MM-DD-<topic>.md`. Keep their checkboxes honest.
- Never push, publish, or change external accounts/settings unless the owner approved it (an approved plan counts).
- Project facts go into the committed `MEMORY.md`, not only into your private memory, so every agent and contributor
  sees them.
- Local tool state (see `.gitignore`) and the owner's private notes are never committed or quoted.
