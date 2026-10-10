# Installation, upgrades, and rollback

## Requirements

- Pi, with child processes able to resolve its model configuration and credentials.
- See [compatibility and verification](README.md#compatibility-and-verification) for the host baseline, CI targets, and manual-validation limits. Automated checks do not establish every platform or provider/subscription flow.
- Git for repository-based installs. This package is not currently published to npm.

Only enable one implementation of `subagent` / `subagent_task`. If using Plan Mode, also keep only one `/plan` extension. Disable an older implementation before enabling this one, and record its previous configuration/link targets.

## Install as a Pi package

```bash
pi install git:github.com/mothieras/pi-subagent
```

This tracks the default branch. To pin a reviewed tag or commit, append `@<ref>` to the source; Pi keeps versioned Git references pinned.

Package resources are:

| Resource | Entry |
| --- | --- |
| Delegation tools | `index.ts` |
| Workflow prompts | `prompts/` |
| Delegation skill | `skills/pi-subagent/SKILL.md` |

Role files and the Plan Mode companion are optional and not installed by the package manifest. Prompts using named roles need those roles installed first.

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

- **Pinned package:** select a new reviewed tag/commit rather than moving an existing tag. Pi recognizes the same repository identity, so inspect the resulting declaration with `pi list`.
- **Unpinned package:** `pi update git:github.com/mothieras/pi-subagent` reconciles the repository checkout.
- **Local/fixed release:** prepare and verify the new checkout/worktree, record old link targets, then switch the extension and installed companion/roles/prompts/skill together. Record newly added resources separately.

Preserve existing custom roles, prompts, and skills. Reload or start a new session and repeat the verification checklist. Keep the old release while any links or active sessions still reference it; remove unused worktrees with `git worktree remove` only after checking those references.

## Rollback

Restore the previous package declaration or recorded link targets. Remove only resources added by the failed installation that still point to that installation; retain files customized since then. Reload or start a new session.

Rollback/cancellation does not undo code changes, external actions, or model usage. Results and running tasks do not survive reload; save important findings first.
