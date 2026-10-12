# Installation, upgrades, and rollback

## Requirements

- Pi, with child processes able to resolve its model configuration and credentials.
- See [compatibility and verification](README.md#compatibility-and-verification) for the host baseline, CI targets, and manual-validation limits. Automated checks do not establish every platform or provider/subscription flow.
- Git for repository-based installs. npm installation uses the public package `@mothieras/pi-subagent`.

Only enable one implementation of `subagent` / `subagent_task`. If using Plan Mode, also keep only one `/plan` extension. Disable an older implementation before enabling this one, and record its previous configuration/link targets.

## Install as a Pi package

Install a reviewed npm release:

```bash
pi install npm:@mothieras/pi-subagent@0.1.4
```

Versioned npm specifications stay pinned; choose a new version deliberately when upgrading. To track the latest published npm release, omit `@0.1.4` and update with `pi update npm:@mothieras/pi-subagent`. Git commits alone do not update npm installations.

Alternatively, install from Git:

```bash
pi install git:github.com/mothieras/pi-subagent
```

This tracks the default branch. To pin a reviewed tag or commit, append `@<ref>` to the source; Pi keeps versioned Git references pinned.

When moving from Git/local/symlink installation to npm, record and remove or disable the old installation first: different source types may load the same tools twice. The `pi-package` keyword makes the published package eligible for the [Pi package catalog](https://pi.dev/packages); catalog synchronization is separate from publication.

Package resources are:

| Resource | Entry |
| --- | --- |
| Delegation tools | `index.ts` |
| Workflow prompts | `prompts/` |
| Delegation skill | `skills/pi-subagent/SKILL.md` |

Role files and the Plan Mode companion are included in the distribution but not automatically loaded by the package manifest. Prompts using named roles need those roles installed first.

Use `pi list` to inspect configured packages and `pi config` to select resources. Do not also symlink the extension into the discovery directory: package and symlink installation are alternatives.

### Local checkout

```bash
git clone https://github.com/mothieras/pi-subagent.git
cd pi-subagent
pi install "$PWD"
```

Local packages load directly from that path. Changes become available after reload; use a pinned checkout or the fixed-release layout below when development changes should not affect daily use.

Installing/loading the extension does not require installing its development dependencies. Pi supplies the host packages at runtime.

## Sample roles and workflows

From a reviewed checkout, copy optional roles without overwriting existing custom files:

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/agents"
cp -n agents/*.md "$agent_dir/agents/"
```

`cp -n` skips existing files. On upgrades, review existing role files before updating them. Alternatively, manage explicit role symlinks to a fixed release and record their targets.

Installed roles enable these bundled prompts:

| Command | Sequence |
| --- | --- |
| `/scout-and-plan <task>` | scout → planner |
| `/implement <task>` | scout → planner → worker |
| `/implement-and-review <task>` | worker → reviewer → worker |

No role installation is needed for inline delegation. The extension does not silently install example roles or load them from its own repository.

## Optional Plan Mode companion

The companion checks actual tool permissions and cancels writers when entering read-only mode.

Try it from a checkout without changing persistent settings:

```bash
pi -e ./compat/plan-mode
```

For persistent use, configure `compat/plan-mode/` as an explicit extension path or link that directory into `<agent-dir>/extensions/plan-mode`. First disable any existing `/plan` extension and record its old target. The companion is not automatically loaded by `subagent` or the package manifest.

Keep the directory intact. Its entry point intentionally does not import implementation code from outside the symlinked directory.

## Fixed-release directory installation

For a daily installation independent of the development checkout, create an immutable detached worktree at a release tag or commit. From the repository root:

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
ref=$(git rev-parse HEAD)  # Or choose a reviewed release tag.
release_dir="$agent_dir/local-releases/pi-subagent/$ref"
mkdir -p "$(dirname "$release_dir")"
git worktree add --detach "$release_dir" "$ref"
```

Load the whole release directory, not a lone `index.ts`: the extension imports several neighboring modules. A conventional directory layout is:

```text
<agent-dir>/
├── extensions/
│   ├── subagent -> <release-dir>/
│   └── plan-mode -> <release-dir>/compat/plan-mode/  (optional)
├── skills/
│   └── pi-subagent -> <release-dir>/skills/pi-subagent/  (if present)
├── agents/       (optional reviewed roles)
└── prompts/      (optional workflow files or links)
```

Create links only at unoccupied destinations. If a destination already exists, inspect it, preserve its old target/content, and replace it only as part of an intentional upgrade. Avoid force-link commands that overwrite custom resources. Keep installation records outside automatically discovered resource directories; never copy credentials into them.

A link under `extensions/` discovers the extension only; install the skill/prompts separately for this layout. Do not also register the same release as a Pi package.

## Activate and verify

Finish the current turn, then run `/reload` or start a new session. The existing session retains old tool definitions and skill metadata until reload.

Verify:

1. Exactly one `subagent`, one `subagent_task`, and at most one `/plan` are loaded.
2. A no-role inline read-only task succeeds with the expected model and tools.
3. Background completion wakes the parent and results are readable by task ID.
4. Usage appears in `subagent_task` totals, not the native Pi `/session` ledger.
5. If installed, `/skill:pi-subagent <task>` loads the delegation guide and named-role workflows find their roles.
6. If installed, Plan Mode rejects writable/default tool loadouts and cancels existing writers.

These checks may call a real model and incur usage; the repository's automated tests do not.

## Upgrade

- **Pinned Git package:** select a new reviewed tag/commit rather than moving an existing tag. Pi recognizes the same repository identity, so inspect the resulting declaration with `pi list`.
- **npm package:** select a new reviewed version with `pi install npm:@mothieras/pi-subagent@<version>`. Unversioned installs can be updated with `pi update npm:@mothieras/pi-subagent`. Inspect the resulting declaration with `pi list`.
- **Unpinned package:** `pi update git:github.com/mothieras/pi-subagent` reconciles the repository checkout.
- **Local/fixed release:** prepare and verify the new checkout/worktree, record old link targets, then switch the extension and installed companion/roles/prompts/skill together. Record newly added resources separately.

Preserve existing custom roles, prompts, and skills. Reload or start a new session and repeat the verification checklist. Keep the old release while any links or active sessions still reference it; remove unused worktrees with `git worktree remove` only after checking those references.

## Rollback

Restore the previous package declaration or recorded link targets. Remove only resources added by the failed installation that still point to that installation; retain files customized since then. Reload or start a new session.

Rollback/cancellation does not undo code changes, external actions, or model usage. Results and running tasks do not survive reload; save important findings first.

## Prepare an npm release without publishing

Read `package.json` for the package name and candidate version. Releases target `@mothieras/pi-subagent`, with public access and the official npm registry. A manifest version is not evidence of npm availability. Before publishing each new version, confirm scope permissions and that the name/version has not already been published.

Run from the repository root:

```bash
npm ci --ignore-scripts
npm run check
npm test
git diff --check
npm pack --dry-run --ignore-scripts
```

`npm test` packs to a temporary directory, checks the distribution contents, loads the unpacked resources through Pi, and runs parent/child delegation through the pinned host's declared `bin.pi` executable against a local fake provider. The tarball fixture isolates shared resource discovery and proxy settings; a loopback proxy trap verifies that inference does not use ambient proxies. It neither publishes nor modifies an active Pi installation. The tarball/CLI checks run on the Linux/macOS CI baseline; Windows remains unverified. The dry run lists the files that would ship without writing a tarball to the checkout.

The `files` allowlist includes every runtime TypeScript module (especially the private `child.ts` bootstrap), optional roles/Plan Mode, prompts, skills, and public documentation. Development dependencies, tests, CI files, local plans, and machine-specific records are not distribution resources. Pi host packages remain `"*"` peers supplied by Pi; do not bundle them or require a TypeScript build.

Publication is a separate authorized action. After approval, finalize the dated changelog entry, recheck the name/version and verification results, and create a new immutable release tag. Publish the reviewed artifact to npm with public access only when explicitly authorized; preparation, a green test run, and catalog eligibility do not grant that authorization. Confirm registry availability and catalog discovery afterward; neither immediate indexing nor a synchronization interval is guaranteed. Keep the installation documentation aligned with the reviewed release. See [Contributing](CONTRIBUTING.md#releases) for the maintainer workflow.
