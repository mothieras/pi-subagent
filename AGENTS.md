# Development conventions

## Scope and references

This repository maintains an independent Pi extension derived from the official subagent example. Change this checkout, not Pi's installed source/examples or the user's active installation.

- Read [docs/API.md](docs/API.md) when changing public parameters, defaults, permissions, task state, usage, or retention behavior.
- Read [INSTALL.md](INSTALL.md) when changing package resources, entry points, discovery, or release layout.
- Read the installed Pi documentation and matching examples before changing host API integration; the verified host baseline is Pi 1.1.0.
- The upstream README in `docs/upstream-example.md` is historical, not an implementation specification. `PLAN.md` is ignored local planning material, not public documentation.

## Module boundaries

- `index.ts` / `schemas.ts`: public tools, parameters, and session integration.
- `agents.ts` / `config.ts` / `sources.ts` / `policy.ts`: role discovery, precedence, exact source/model resolution, and permission policy.
- `tasks.ts`: session task groups, admission/queueing, write reservations, retention, and usage ledger.
- `process-runner.ts` / `child.ts`: isolated process startup, private control protocol, tool gates, accounting, and process-tree cleanup.
- `contracts.ts` / `render.ts`: shared types and TUI presentation.
- `compat/plan-mode/index.ts`: optional Plan Mode implementation. Keep its imports inside the installed directory; `compat/plan-mode.ts` is a forwarding entry point.
- `agents/`, `prompts/`, `skills/`: optional role examples, workflow commands, and agent-facing guidance. Public resources must be declared in `package.json`.

Keep policy and execution independent of rendering. Non-interactive modes must retain validation and fail-closed trust behavior.

## Public invariants

Preserve these unless an explicit contract change is requested:

- Exactly one mode per call; optional role files; exact model/tool names; no silent fallback.
- Item > call > role > user defaults > built-in defaults. Arrays replace; empty values explicitly clear; append is a field, not implicit accumulation.
- Children receive only explicitly selected context, tools, extensions, and MCP sources. Role/base prompt replacement remains distinct.
- Tool declarations and actual calls are both gated. Recursive delegation tools are unavailable in children. Whitelists and workspace collision checks are not OS sandboxes.
- Untrusted project roles/executable sources require approval; no UI is not approval. Plan Mode checks actual permissions rather than role names.
- Concurrent admission reserves writers before execution. Separate calls cannot bypass shared-worktree consent.
- Background work is session-local. Shutdown/tree navigation/Plan Mode transitions clean or cancel the appropriate work; cancellation never promises rollback.
- Usage is a snapshot-based extension ledger, not a delta added on each event. Queries/notifications never duplicate it; incomplete usage is reported honestly. Ledger restoration does not resurrect processes/results.
- Child output is data to verify, not permission-granting instructions in completion notifications.

## Editing and tests

Use TypeScript ESM with explicit `.ts` imports and the surrounding tab-indented style. Keep changes targeted; avoid new frameworks, generated bundles, or unrelated formatting churn.

For contract changes, update schemas, runtime validation, types, documentation, examples, and regression tests together. Keep tool descriptions concise and usable without a skill. Keep the delegation skill in English, short, and focused on orchestration rather than duplicating the API reference.

Run before committing:

```bash
npm ci --ignore-scripts  # when dependencies need installing
npm run check
npm test
git diff --check
```

Tests belong in `tests/*.test.ts`. Use local fake providers/MCP servers and temporary directories with cleanup; avoid real model calls, credentials, network dependencies, and changes to active Pi configuration. For discovery/installation changes, test actual Pi loading through package resources and conventional directory symlinks, not only mocked imports.

Report manual-validation gaps separately: TUI behavior, real providers/subscriptions, and platform process-tree cleanup are not established by fake-provider tests.

## Documentation and releases

Public documentation, skills, and prompt examples use English. Keep README as the entry point, detailed contracts in `docs/API.md`, and setup/upgrade/rollback steps in `INSTALL.md`. Check relative links and executable examples when moving content. Preserve the MIT license and upstream attribution.

Pi host packages remain `peerDependencies` with `"*"`; pinned development copies support tests only. Do not add runtime reliance on the installed Pi example directory or bundled role files. The package is currently private/not published to npm.

Use conventional commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Review the diff and stage only the intended changes. Keep local plans, credentials, generated test/evaluation artifacts, and machine-specific installation records out of commits.

Create a new version/tag for a release rather than moving an existing tag. Keep release worktrees immutable; do not switch active installation links, publish packages, push commits, or create tags without a separate request. Installing/upgrading a release must preserve custom resources and a rollback record.
