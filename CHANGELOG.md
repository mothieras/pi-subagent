# Changelog

User-visible changes are recorded here. `Unreleased` describes changes in the current development branch, not an already-published version. The manifest may target an unreleased candidate; only dated entries describe releases. The v0.1.0–v0.1.2 entries were reconstructed from immutable Git tags and commit history.

## [Unreleased]

### Added

- Optional per-child `config.timeoutMs` runtime deadlines with item/call/role/user-default precedence and explicit `0` to disable an inherited limit. Queueing is excluded; timed-out children fail after cancellation cleanup, retain output and reported usage, skip later chain steps, and leave parallel siblings running.

### Changed

- Move detailed delegation, runtime-limit, and result-collection guidance into the on-demand skill; shorten tool summaries while retaining standalone call essentials and safety boundaries.
- Make the default npm installation command use the latest published release, while retaining explicit version-pinning and update guidance.

## [0.1.5] - 2026-10-12

### Fixed

- Count running/cancelling child items rather than delegation groups in the TUI footer, and show queued items separately, including future chain steps ([#10](https://github.com/mothieras/pi-subagent/pull/10)).

## [0.1.4] - 2026-10-12

### Added

- npm distribution verification using an actual tarball, unpacked Pi package/resource discovery, conventional directory symlinks, and the shipped Pi parent/child CLI against a loopback fake provider, with shared-resource/proxy isolation and a hostile-proxy regression.

### Changed

- Introduce public npm distribution as `@mothieras/pi-subagent`, with an explicit file allowlist and public registry/access configuration.
- Document npm installation and updates, source migration, release preparation, and the separate authorization required for publication.
- Upgrade and pin the development TypeScript compiler from 5.9.3 to 7.0.2, keeping the Node.js 24 and Pi 1.1.0 baselines unchanged.
- Update the development YAML parser from 2.9.0 to 2.9.1 without changing the pinned Pi host dependencies.

## [0.1.3] - 2026-10-11

### Added

- Node.js 24 CI on Linux/macOS, with offline tests, type checking, read-only workflow permissions, commit-pinned Actions, and revalidation after PR base changes.
- Contribution and security guidance, issue/PR templates, weekly dependency-update proposals, and this changelog.

### Changed

- Restructure README around installation, bounded delegation, result collection, and safety; make compatibility and validation limits explicit.
- Streamline the coding-agent guide with conditional references, module boundaries, invariants, and a checkable contribution loop.
- Track complete retained-output delivery through successful finalized tool results and expose `resultDelivered` in task list/status. Delivery is not acceptance; no ACK action is required.

### Fixed

- Recheck and batch busy-parent completion reminders before settlement, suppressing stale wakeups after complete output delivery while preserving reminders for partial/log/error/aborted/redacted reads ([#2](https://github.com/mothieras/pi-subagent/pull/2)).
- Prevent running-output and eviction/read races from falsely recording complete delivery; suppress pending old-branch reminders during navigation.

## [0.1.2] - 2026-10-09

### Added

- English delegation skill packaged alongside tools and workflow prompts.
- API reference, coding-agent conventions, documentation link/example tests, and actual skill/package discovery coverage.

### Changed

- Rewrite public documentation in English and archive the original example README for provenance.
- Keep tool descriptions usable without loading the delegation skill.

## [0.1.1] - 2026-10-08

### Fixed

- Keep Plan Mode implementation imports inside the installed directory so conventional directory-symlink discovery loads the companion correctly.

## [0.1.0] - 2026-10-08

### Added

- Independent isolated child Pi processes with optional Markdown roles and inline configuration.
- Single, parallel, and sequential delegation; explicit model/tool/source selection, trust checks, and Plan Mode permission enforcement.
- Session-local background tasks, paginated results, cancellation, write-collision checks, retention limits, and snapshot-based child usage accounting.
- Optional role/workflow examples, Plan Mode companion, and versioned installation/rollback guidance.

[Unreleased]: https://github.com/mothieras/pi-subagent/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/mothieras/pi-subagent/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/mothieras/pi-subagent/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/mothieras/pi-subagent/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/mothieras/pi-subagent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/mothieras/pi-subagent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mothieras/pi-subagent/tree/v0.1.0
