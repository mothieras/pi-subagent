# Pi Subagent

Task delegation for [Pi](https://github.com/earendil-works/pi), with isolated child contexts, optional Markdown roles, and session-local background execution.

Delegate a self-contained task without creating a role file, run independent investigations in parallel, or chain implementation and review. Each child runs in a separate Pi process with an explicit tool allowlist.

## Features

- **Flexible delegation** — single tasks, parallel task groups, and sequential chains with `{previous}` handoffs.
- **Optional roles** — reusable Markdown agents or inline prompt/model/tool configuration.
- **Explicit tool sources** — select trusted extensions and MCP servers rather than inheriting the parent's integrations.
- **Session-local background work** — task IDs, completion notifications, status, paginated results, and cancellation.
- **Separate usage accounting** — reported child usage is tracked once in the extension's ledger.
- **Write-collision checks** — shared-worktree parallel writers require explicit consent.

**Isolation is not an OS sandbox.** Shell commands, extensions, and MCP code retain host permissions. Background tasks do not survive session exit, switching, or reload.

## Install

Requires Pi. The current implementation is tested with **Pi 1.1.0, Node.js 24, and macOS**. Windows/Linux whole-system behavior and real provider/subscription flows still need manual verification.

```bash
pi install git:github.com/mothieras/pi-subagent
```

Then start a new Pi session or run `/reload` after the current turn finishes. Keep only one implementation of the `subagent` tools enabled.

The package exposes the extension, workflow prompts, and the delegation skill. **Sample role files require separate installation.**

See [INSTALL.md](INSTALL.md) for pinned/local installations, sample roles, optional Plan Mode support, upgrades, and rollback. The package is not currently published to npm.

## Quick start

No role file is required. Ask Pi to delegate a bounded investigation, or use this `subagent` call:

```json
{
  "task": "Inspect authentication under src/. Return entry points, file paths, line numbers, and evidence of missing permission checks. Do not modify files.",
  "config": {
    "tools": {
      "allow": ["read", "grep", "find", "ls"],
      "extensions": [],
      "mcp": []
    }
  }
}
```

Children do **not** receive the parent conversation, context files, or skills. Include the goal, necessary context, scope, constraints, and expected deliverable in every task.

### Independent tasks

```json
{
  "tasks": [
    { "task": "Inspect src/auth/ for authorization gaps. Return paths, line numbers, and evidence." },
    { "task": "Inspect src/storage/ for unsafe persistence. Return paths, line numbers, and evidence." }
  ],
  "config": {
    "tools": { "allow": ["read", "grep", "find", "ls"], "extensions": [], "mcp": [] }
  },
  "background": true
}
```

Background completion normally notifies and wakes the parent. Read the result using `subagent_task` with `action: "result"` and the returned task ID; follow `nextCursor` for additional pages.

### Dependent steps

Use `chain` when a step needs its predecessor's output:

```json
{
  "chain": [
    { "task": "Investigate authentication under src/. Return relevant paths and evidence." },
    { "task": "Create an implementation plan from these findings; do not implement:\n{previous}" }
  ],
  "config": {
    "tools": { "allow": ["read", "grep", "find", "ls"], "extensions": [], "mcp": [] }
  }
}
```

Run shared-worktree implementation/review sequentially. Prefer separate worktrees for parallel writers; this extension does not create worktrees or merge changes.

## Documentation

- [API reference](docs/API.md) — parameters, roles, configuration precedence, tool sources, lifecycle, usage, and limits.
- [Installation](INSTALL.md) — installation options, upgrades, and rollback.
- [Delegation skill](skills/pi-subagent/SKILL.md) — a short agent-facing guide to handoffs and verification; explicitly load it with `/skill:pi-subagent <task>` after installation.
- [Development conventions](AGENTS.md) — repository boundaries and change/verification rules.

Tool descriptions remain usable without loading the skill. The skill guides the parent; it does not change child isolation or permissions.

## Development

```bash
git clone https://github.com/mothieras/pi-subagent.git
cd pi-subagent
npm ci --ignore-scripts
npm run check
npm test
```

Tests use fake local models/MCP servers and isolated temporary directories. They do not call real providers or modify the active Pi installation. Coverage includes configuration, source selection, permission gates, process cleanup, background wakeups, accounting, result pagination, and package/skill discovery.

Automated tests do not establish real-provider compatibility or interactive TUI behavior. Review the conventions in [AGENTS.md](AGENTS.md) before changing public contracts.

## License and attribution

[MIT](LICENSE). Derived from the official subagent example in `@earendil-works/pi-coding-agent` 1.1.0, with upstream attribution retained. This repository maintains its own implementation; the [original example README](docs/upstream-example.md) is archived for provenance.
