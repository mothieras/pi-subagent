# API reference

For setup, see [installation](../INSTALL.md). For orchestration guidance, use the [delegation skill](../skills/pi-subagent/SKILL.md).

## `subagent`

Choose exactly one execution mode:

| Field | Mode | Behavior |
| --- | --- | --- |
| `task` | Single | One self-contained task, with optional top-level `agent`. |
| `tasks` | Parallel | Independent task items; at most 8 per call. |
| `chain` | Sequential | Task items run in order; `{previous}` inserts the preceding retained final output. |

Each item in `tasks` or `chain` accepts `agent?`, `task`, `cwd?`, and `config?`. Top-level `agent`/`task` cannot be combined with either collection. Chains stop on failure or cancellation; unexecuted steps are marked skipped/cancelled. Handoffs are subject to retained-output limits.

Shared options:

| Field | Default | Purpose |
| --- | --- | --- |
| `cwd` | Parent working directory | Working directory for items without their own `cwd`. |
| `config` | Resolved defaults | Common configuration, overridden by item configuration. |
| `agentScope` | `"user"` | Role discovery: `"user"`, `"project"`, or `"both"`. |
| `background` | `false` | Return a session-local task group ID after validation, approval, and registration. |
| `notify` | `true` | Notify and wake the parent when a background group finishes. |
| `allowSharedWrites` | `false` | Explicit consent for overlapping parallel writers. |

### Inline configuration

```json
{
  "task": "Review authentication. Return only evidence-backed findings; do not modify files.",
  "config": {
    "model": "inherit",
    "thinking": "high",
    "rolePrompt": {
      "replace": "You are a code reviewer.",
      "append": "Focus on authorization bypasses."
    },
    "tools": {
      "allow": ["read", "grep", "find", "ls"],
      "extensions": [],
      "mcp": []
    }
  }
}
```

- `model`: exact `provider/id`, a unique exact model ID, or `"inherit"`. No fuzzy matching or silent fallback. Explicit provider extensions may introduce a model unknown to the parent, but require an exact `provider/id` and child catalog validation.
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `"inherit"`. Pi clamps it to model capabilities; results/status report the actual value.
- `rolePrompt.replace`: replace the selected role instructions. `rolePrompt.append`: append instructions to that role.
- `systemPrompt`: independently replace Pi's base prompt; the explicitly selected role and working directory remain. Tool permissions are enforced separately from prompt text.
- `tools.allow`: exact tool-name allowlist. `[]` exposes no tools. Wildcards and `+/-` selectors are unsupported.
- `tools.extensions`: explicitly selected executable extension sources.
- `tools.mcp`: explicitly selected MCP server names.

Children do not receive the parent conversation, full parent prompt, ambient `SYSTEM.md`/`APPEND_SYSTEM.md`, context files, skills, or workflow prompts. Pass necessary context and instructions in the task.

`"inherit"` reads the parent's model/thinking selection at dispatch time. It does not transfer in-memory credentials, runtime providers, or virtual-model implementations. The child needs usable credentials/configuration and explicitly selected trusted provider extensions when required.

### Precedence and paths

**Item configuration > call configuration > role file > user defaults > built-in defaults.**

Objects merge by field; arrays replace rather than combine. Empty strings/arrays explicitly clear values. `rolePrompt.append` is one field: a higher-priority append replaces the lower-priority append instead of implicitly stacking it.

Built-in defaults inherit model/thinking, expose `read,bash,edit,write`, and select no external sources. Roles and user defaults may override them.

Relative call paths, including item `cwd` and extension overrides, resolve from the parent invocation directory, not from an overridden task directory. Role extension paths resolve from the role file's directory. User-default paths resolve from the agent directory.

## Markdown roles

```markdown
---
name: investigator
description: Read-only investigation
tools:
  allow: [read, grep, find, ls]
  extensions: []
  mcp: []
model: inherit
thinking: inherit
---

Investigate the repository and return exact paths, line numbers, and evidence.
```

- User roles: `<agent-dir>/agents/*.md`, selected by default.
- Project roles: `.pi/agents/*.md` in the nearest ancestor with that directory; require explicit `agentScope: "project"` or `"both"`.
- With `"both"`, a project role overrides a user role of the same name. Results/status record selected/shadowed files and field provenance.
- Qualified names such as `user:reviewer` and `project:reviewer` select a source precisely, but still obey the chosen scope.
- Untrusted project roles require interactive approval. Without UI/approval they are rejected.

CSV fields such as `tools: read, grep` and YAML tool arrays are also supported. Invalid frontmatter produces diagnostics and excludes the role; it never turns malformed tool configuration into full permissions.

The repository's `agents/` directory contains optional examples. It is not installed or loaded automatically. Scout/planner/reviewer select built-in read-only tools and clear external sources; worker uses resolved defaults. See [installation](../INSTALL.md#sample-roles-and-workflows).

## External tools and trust

```json
{
  "task": "Look up the requested documentation and cite the relevant sections.",
  "config": {
    "tools": {
      "allow": ["read", "custom_lookup", "mcp__docs__lookup"],
      "extensions": ["/absolute/path/to/trusted-tools.ts"],
      "mcp": ["docs"]
    }
  }
}
```

Selecting a source and allowing a tool are separate operations. The extension does not automatically inherit parent extensions or MCP connections.

- Extensions must be explicit local files/directories with an entry point, or supported built-ins `builtin:codemode` / `builtin:tool-search`. Loading `builtin:mcp` directly is unsupported; MCP selection is controlled here.
- External extensions execute with host permissions. Approve them interactively or list canonical trusted paths in user `trustedExtensions`.
- MCP configurations are snapshotted from user `mcp.json`, a trusted project configuration when child and parent directories match, or servers registered by parent extensions. Only selected servers connect.
- Missing models/tools, invalid sources, and failed connections produce errors. Asynchronous MCP tools have a 15-second readiness deadline; diagnostics are retained.
- Direct, nested, and dynamically enabled tools remain subject to the actual call allowlist; declarations are reconciled before provider requests.
- `subagent` and `subagent_task` cannot appear in child allowlists.

**This is not an OS sandbox.** Shell commands, extensions, and MCP code can access other directories or start programs. The recursion restriction applies to Pi delegation tools, not every possible program launched through a shell. Use an external container/OS sandbox for process, filesystem, or network isolation.

### User defaults

Optional `<agent-dir>/subagent.json` (agent directory defaults to `~/.pi/agent`):

```json
{
  "defaults": {
    "model": "inherit",
    "thinking": "inherit",
    "tools": { "allow": ["read", "bash", "edit", "write"] }
  },
  "trustedExtensions": ["/absolute/path/to/trusted-tools.ts"]
}
```

Configuration is reread on each call. Only user configuration is loaded; project `subagent.json` is not automatically read.

## `subagent_task`

| Action | Required fields | Result |
| --- | --- | --- |
| `list` | `action` | Known groups and complete extension usage totals. |
| `status` | `action`, `taskId` | Group/item state, resolved configuration, diagnostics, and usage. |
| `result` | `action`, `taskId` | Retained output or log page. |
| `cancel` | `action`, `taskId` | Cancel active processes and queued items. |

`result` also accepts `view: "output"` (default) or `"log"`, byte `cursor`, and positive `maxBytes`.

```json
{
  "action": "result",
  "taskId": "<returned-task-id>",
  "view": "output",
  "cursor": 0,
  "maxBytes": 16384
}
```

Continue with the returned `nextCursor` until it is `null`. Use returned offsets rather than splitting UTF-8 characters yourself. Very small pages may expand to one whole character. A running log is a changing snapshot: read from cursor 0; after completion it can be paged stably.

### Background lifecycle

`background: true` returns a group ID without waiting for the model. Each item also has an `itemId`. Background work is not tied to the launching turn's abort signal.

Completion/failure/explicit cancellation normally queues a `followUp`: busy parents receive it afterward; idle parents start a new turn. That parent turn can incur model usage. `notify: false` disables the automatic wakeup.

Notifications contain ID/state, not arbitrary child output as new instructions. They grant no permissions. Read results separately and verify them before integration.

Exit, session switch, and reload clean processes, timers, listeners, and temporary artifacts. `/tree` navigation cancels active work so old-branch results cannot wake a new branch. Tasks/results are not restored; only the usage ledger is restored. SIGKILL, system crashes, and deliberately detached/escaped processes cannot be guaranteed cleanup. Cancellation does not roll back changes or external actions.

### Parallel writers

All foreground/background groups share **4 process slots**. Active/queued groups reserve at most **32 total items**; an entire group's quota is released only when it ends.

Potential writers in the same Git worktree are rejected by default, including overlap across separate calls. Both overlapping groups must explicitly set `allowSharedWrites: true` to permit it. Sequential chains and independent worktrees are supported. Non-Git workspaces use canonical path/ancestor overlap checks.

Shell tools, unknown custom tools, and MCP loadouts are treated as potentially writable. Workspace checks prevent declared-workspace collisions; they do not constrain tools to that workspace. No worktree creation or automatic merge is provided.

## Usage and retention

The extension ledger is authoritative for reported child calls. **Pi's native `/session` and footer do not include this extension's child usage.** `list` reports session totals; status/rendering expose group/item totals. Queries, progress, and notifications do not charge usage again.

Usage includes reported model, tool-embedded model, and compaction usage. Reasoning/cache-write subsets are not double-counted. Failed/cancelled tasks retain known usage. Hard kills/protocol failures can leave server usage unreported: `usageComplete: false` means the total is incomplete, not free. Absolute ledger snapshots persist on completion/normal shutdown; reload/resume restores accounting only.

Artifacts live under a system temporary `pi-subagent-session-*` directory (0700; files 0600):

| Limit | Default |
| --- | --- |
| Log per item | 1 MiB |
| Output per item | 256 KiB |
| Protocol event / display cache | 1 MiB each |
| Combined model-visible foreground result | About 50 KiB |
| Result query page | At most 50 KiB |
| Retained completed groups | 16 |
| Retained completed log/output data | 64 MiB |

Oversized protocol events terminate the child with diagnostics. Truncated logs/output are marked; omitted bytes are not retained. Old artifacts can be evicted before session exit. There is no time TTL; bounded expired-state records eventually give way to accounting totals. Configuration snapshots (potentially containing MCP credentials) are removed when an item exits or is skipped; closing the session removes the temporary directory.

## Plan Mode

The extension reads `plan-mode-state` and checks resolved permissions. Plan Mode permits only `read,grep,find,ls`, with no external sources. Entering it cancels existing writers without undoing completed actions. Notifications remain subject to current permissions.

An optional companion at `compat/plan-mode/` supports actual permission checks, task management, and waiting for writer cancellation. Install it explicitly and retain only one `/plan` extension; see [installation](../INSTALL.md#optional-plan-mode-companion).
