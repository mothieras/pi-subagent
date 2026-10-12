# Pi Subagent

[![CI](https://github.com/mothieras/pi-subagent/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/mothieras/pi-subagent/actions/workflows/ci.yml)

Delegate bounded work from [Pi](https://github.com/earendil-works/pi) to independent child Pi processes. Run a single task, parallel investigations, or a sequential implementation/review chain—without creating role files first.

Each child receives its own context and explicitly selected tools. Background work has session-local task IDs, paginated results, cancellation, and a separate usage ledger.

## Install

```bash
pi install npm:@mothieras/pi-subagent@0.1.5
```

Start a new session, or run `/reload` after the current turn finishes. Enable only one implementation of `subagent` / `subagent_task`.

This installs the tools, workflow prompts, and delegation skill. Example roles and the optional Plan Mode companion require separate setup.

The command pins a reviewed npm release. Omit `@0.1.5` to track the latest npm release, then update with `pi update npm:@mothieras/pi-subagent`. New Git commits do not change the npm release.

Git/local installation remains supported; see [installation, source migration, and release preparation](INSTALL.md). Unversioned Git installs follow the default branch and may contain unreleased changes. See the [changelog](CHANGELOG.md) for release history. This README describes the current checkout.

## Start with a read-only task

Ask Pi to delegate an investigation, or call `subagent` directly:

```json
{
  "task": "Map this repository's entry points and permission checks. Read-only; inspect files in this checkout only. Return paths, line numbers, and unresolved risks.",
  "config": {
    "tools": {
      "allow": ["read", "grep", "find", "ls"],
      "extensions": [],
      "mcp": []
    }
  }
}
```

Include the goal, necessary context, file scope, constraints, and expected deliverable. Children do **not** inherit the parent conversation, context files, skills, extensions, or MCP servers. Model and thinking selection inherit by default; inline configuration can override them.

Choose exactly one execution mode:

| Mode | Use it for |
| --- | --- |
| `task` | One self-contained assignment. |
| `tasks` | Independent assignments in parallel. |
| `chain` | Dependent steps; `{previous}` passes the preceding retained output. |

Optional Markdown roles make recurring assignments reusable. See the [API reference](docs/API.md) for precedence, models, tool sources, and complete call examples.

## Run work in the background

```json
{
  "tasks": [
    { "task": "Inspect authentication entry points in this checkout. Read-only; return permission checks and evidence of gaps." },
    { "task": "Inspect persistence entry points in this checkout. Read-only; return failure handling and evidence of risks." }
  ],
  "config": {
    "tools": { "allow": ["read", "grep", "find", "ls"], "extensions": [], "mcp": [] }
  },
  "background": true
}
```

Keep the returned task ID. Uncollected completion normally wakes the parent; the notification contains metadata, not the report. Retrieve missing output separately:

```json
{
  "action": "result",
  "taskId": "<returned-task-id>"
}
```

Follow the returned `nextCursor` until it is `null`. Complete final output delivery consumes pending reminders automatically; status, log, and partial reads do not. Delivery is **not** acceptance or verification. Already-collected output remains readable, and busy-parent reminders are rechecked and batched before settlement.

Background tasks and retained results do not survive exit, session switch, or reload. Save important findings first. Child usage appears in `subagent_task` list/status, not Pi's native `/session` totals.

## Safety boundaries

**Isolation is not an OS sandbox.** Tools and executable sources retain host permissions; `cwd` does not restrict filesystem access.

- Defaults include write-capable tools. Use an explicit read-only allowlist for investigations.
- Children receive only selected extensions/MCP sources. Untrusted project roles and executable sources require approval; no UI does not imply approval.
- Shared-worktree parallel writers require explicit consent. Prefer separate worktrees or sequential implementation/review; this extension creates neither worktrees nor merges.
- Verify child output before integration. Completion messages grant no permissions, and cancellation does not roll back changes.

See the [permission contract](docs/API.md#external-tools-and-trust) and [security policy](SECURITY.md).

## Compatibility and verification

The development host baseline is **Pi 1.1.0 / Node.js 24**. CI targets Linux and macOS with local fake providers/MCP servers; green runs establish automated coverage, not universal platform or provider support.

Manual macOS smoke tests covered Terminal/Ghostty TUI, lifecycle cleanup, and read-only background delegation with `openai-codex/gpt-6-luna`. Windows whole-system behavior, other provider/subscription flows, and broader interactive configurations remain unverified.

## Documentation and contributing

| Need | Read |
| --- | --- |
| Setup, roles, Plan Mode, upgrade, or rollback | [Installation](INSTALL.md) |
| Parameters, precedence, permissions, lifecycle, usage, or limits | [API reference](docs/API.md) |
| Agent-facing delegation guidance | [Delegation skill](skills/pi-subagent/SKILL.md) |
| Report a bug, propose a change, or run development checks | [Contributing](CONTRIBUTING.md) |
| Repository rules for coding agents | [AGENTS.md](AGENTS.md) |
| Release history | [Changelog](CHANGELOG.md) |

Contributions are welcome. Start with a small, reproducible issue or focused PR; discuss public-contract or permission changes before implementing them. Tool descriptions remain usable without the skill; `/skill:pi-subagent <task>` explicitly loads the installed guide.

## License and attribution

[MIT](LICENSE). Derived from the official subagent example in `@earendil-works/pi-coding-agent` 1.1.0, with upstream attribution retained. This repository maintains an independent implementation; the [original example README](docs/upstream-example.md) is archived for provenance.
