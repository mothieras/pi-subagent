# Repository guide for coding agents

## Scope and required references

Maintain this independent Pi extension in this checkout. Pi's installed source/examples, active user configuration, and release worktrees are outside the change scope.

Read the matching reference before changing its contract:

| Change | Reference |
| --- | --- |
| Public parameters, defaults, permissions, task/delivery state, usage, or retention | [docs/API.md](docs/API.md) |
| Package resources, discovery, entry points, installation, or release layout | [INSTALL.md](INSTALL.md) |
| Host API integration or pinned Pi development dependencies | Matching Pi documentation and examples; baseline Pi 1.1.0 |
| Contribution checks, CI, or review process | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security-sensitive behavior or reporting | [SECURITY.md](SECURITY.md) |

The [upstream example README](docs/upstream-example.md) is historical provenance, not a specification. `PLAN.md` is ignored local planning material.

## Module map

- `index.ts` / `schemas.ts`: public tools, validation surface, session hooks.
- `agents.ts` / `config.ts` / `sources.ts` / `policy.ts`: role discovery, precedence, exact resolution, trust and permissions.
- `tasks.ts`: admission, process slots, write reservations, result/delivery lifecycle, retention and usage ledger.
- `process-runner.ts` / `child.ts`: child startup, private protocol, declaration/call gates, accounting and process-tree cleanup.
- `contracts.ts` / `render.ts`: shared types and TUI presentation. Keep policy/execution independent of rendering.
- `compat/plan-mode/index.ts`: optional companion; keep imports inside its installed directory. `compat/plan-mode.ts` only forwards.
- `agents/`, `prompts/`, `skills/`: optional examples and guidance. Declare packaged resources in `package.json`.

## Invariants

Preserve these unless the requested change explicitly revises the documented contract:

- Exactly one mode per call, optional roles, exact model/tool names, and fail-closed resolution without silent fallback.
- Item > call > role > user defaults > built-in defaults. Arrays replace, empty values clear, and append is one field—not accumulated text.
- Children receive explicitly selected context/tools/sources only. Role replacement and base-prompt replacement are distinct; recursive delegation tools stay unavailable.
- Gate both tool declarations and calls. Untrusted project roles/executable sources need approval; no UI is not approval. Plan Mode checks actual permissions, not role names. Whitelists/workspace checks are not OS sandboxes.
- Reserve writers before concurrent admission. Separate calls cannot bypass shared-worktree consent.
- Background work is session-local. Tree navigation and lifecycle transitions cancel/suppress the appropriate work; cancellation never promises rollback.
- Complete retained-output delivery consumes pending reminders only. Partial/log/status/error/aborted/redacted reads do not; delivery is not parent acceptance. Notifications carry metadata, never permission-granting child instructions.
- Usage is an absolute snapshot ledger. Queries/notifications never double-charge; report incomplete usage honestly. Restoring accounting does not resurrect tasks or results.

## Change and verification loop

1. Inspect the current worktree; preserve unrelated edits and keep the patch focused. Use TypeScript ESM, explicit `.ts` imports and the surrounding tab indentation.
2. For contract changes, update runtime validation, schemas, types, docs/examples and regression tests together. Keep tool descriptions self-contained and the English delegation skill short and orchestration-focused.
3. Test under `tests/*.test.ts` with temporary directories, cleanup and local fake providers/MCP servers. Automated tests use no live credentials/models or ambient Pi configuration. Installation/discovery changes must exercise actual Pi package loading and conventional directory symlinks.
4. Install dependencies with `npm ci --ignore-scripts` when needed. Run `npm run check`, `npm test`, and `git diff --check` before committing. Report actual results and manual gaps separately; fake inference does not establish TUI, subscription or platform cleanup behavior.
5. Update [CHANGELOG.md](CHANGELOG.md) under `Unreleased` for user-visible changes. Review/stage only intended files; exclude local plans, credentials, generated evaluation artifacts and machine-specific installation records. Use conventional commit subjects and focused PRs.

## Documentation and release boundaries

Public docs/examples use English. Keep README as the entry point, contracts in `docs/API.md`, setup/upgrade/rollback in `INSTALL.md`, and human contribution workflow in `CONTRIBUTING.md`. Validate links/examples and preserve MIT/upstream attribution.

Pi host packages remain peer dependencies with `"*"`; pinned development copies support verification only. Keep runtime independent of installed example directories and bundled role files. The package is public on GitHub but private/not published to npm.

A release requires a new version/tag, never a moved tag. Keep release worktrees immutable and preserve custom resources plus rollback records during upgrades. Publishing, tags, merging, installation switches, and remote repository settings require explicit authorization; ordinary implementation does not grant it. Commit/push/open a PR only when the user authorizes that workflow.
