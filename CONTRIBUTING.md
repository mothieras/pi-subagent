# Contributing

Bug reports, documentation improvements, tests, and focused implementation PRs are welcome. This is a small, independently maintained Pi extension; discuss public API, permission, dependency-baseline, or release-layout changes before investing in a large patch.

## Report or propose

Use the [issue templates](https://github.com/mothieras/pi-subagent/issues/new/choose). For a bug, include the extension tag/commit, Pi and Node versions, OS, minimal reproduction, expected behavior, and actual result. Distinguish a failing automated case from a manual TUI/provider observation.

Redact credentials, private prompts/reports, account information, and machine-specific paths. Prefer a local fake-provider reproduction over a paid model call. Follow [SECURITY.md](SECURITY.md) for suspected vulnerabilities rather than posting exploit details publicly.

For a feature, describe the use case, current workaround, and affected contract. A proposal is not permission to weaken trust, isolation, or usage guarantees.

## Develop locally

Use Node.js 24 and Git. The lockfile pins development dependencies, including the Pi 1.1.0 host baseline; runtime host packages remain peer dependencies supplied by Pi.

```bash
git clone https://github.com/mothieras/pi-subagent.git
cd pi-subagent
npm ci --ignore-scripts
npm run check
npm test
git diff --check
```

Read [AGENTS.md](AGENTS.md) for module boundaries and invariants. Edit the checkout, not Pi's installed examples or your daily installation. For installation changes, use [INSTALL.md](INSTALL.md) and an isolated configuration/worktree.

Tests belong in `tests/*.test.ts` and must clean up temporary data and child processes. Use loopback fake providers/MCP servers, not real credentials, remote models, or the user's Pi resources. Dependency installation needs registry access; inference tests do not need a subscription. `npm test` also checks documentation links/examples, repository configuration, and the actual npm tarball with unpacked Pi package discovery and offline parent/child delegation.

A live-provider or GUI smoke test is optional and separate: confirm the model, budget, permissions, and isolation first, then report its limited scope. Never treat a fake-provider test as evidence of subscription compatibility or complete platform cleanup.

## Pull requests

1. Branch from the intended base and keep one coherent change per PR. For a stacked PR, identify its dependency and retarget after that base is merged.
2. Add a regression that fails before a bug fix. Keep TypeScript ESM and the surrounding style; avoid unrelated formatting or generated bundles.
3. Update the API/types/schemas/examples together when changing a contract. Add user-visible notes to [CHANGELOG.md](CHANGELOG.md) under `Unreleased`; release preparation moves them into a dated version section.
4. Run the checks above, review the diff, and stage only intended files. Use conventional subjects such as `fix:`, `feat:`, `docs:`, `test:`, `ci:`, or `chore:`.
5. Explain the change, link its issue, provide verification evidence, and list remaining manual gaps. Keep private configuration, raw model transcripts, test artifacts, and local installation records out of the PR.

The maintainer reviews scope, compatibility, tests, and security implications before merging. CI success is necessary evidence, not automatic acceptance; there is no auto-merge policy or guaranteed review turnaround.

## CI and dependency maintenance

[CI](https://github.com/mothieras/pi-subagent/blob/master/.github/workflows/ci.yml) runs on pull requests (including base-branch edits), pushes to `master`, and manual dispatch. Node.js 24 jobs on Linux/macOS install locked dependencies without lifecycle scripts, type-check, run offline tests, check whitespace, and verify that the checkout stays clean. Jobs use a read-only token and no provider secrets. Actions are pinned to full commit SHAs.

Windows is not in the matrix. Read the individual run and skipped cases before claiming platform support. Interactive TUI and real-provider behavior still need scoped manual validation.

[Dependabot](https://github.com/mothieras/pi-subagent/blob/master/.github/dependabot.yml) proposes weekly npm and Actions updates. Pi host development packages are grouped because their APIs must move together. Review host updates against matching Pi docs/examples and update the stated baseline when warranted; dependency PRs do not merge automatically.

Branch protection and required status checks are repository settings, not enforced by the workflow itself. Configure them deliberately after the workflow is merged and its check names are established.

## Releases

Distribution supports the public npm package `@mothieras/pi-subagent` and Git/local Pi installation. A maintenance PR or release-preparation patch does not itself release a version.

During preparation, reconcile the manifest/lockfile name and candidate version, keep changes under `Unreleased`, and follow [the npm preparation checklist](INSTALL.md#prepare-an-npm-release-without-publishing). Verify the unpacked tarball, including runtime modules, optional resources, and documentation; keep host packages as `"*"` peers. Confirm npm scope ownership and publication permissions separately.

After explicit release authorization, move `Unreleased` notes into a dated version section, rerun checks, and create a new immutable tag/publication. The manifest's candidate version is not proof of a released tag or npm artifact. Use [INSTALL.md](INSTALL.md) for upgrade/rollback procedures and preserve custom resources. Never move a published tag or silently switch an active installation.

Contributions are distributed under the repository's [MIT license](LICENSE). Keep upstream attribution intact.
