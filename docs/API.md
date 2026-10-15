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
| `notify` | `true` | Notify and wake the parent about finished background groups whose complete results have not already been delivered. |
| `allowSharedWrites` | `false` | Explicit consent for overlapping parallel writers. |

### Inline configuration

```json
{
  "task": "Review authentication. Return only evidence-backed findings; do not modify files.",
  "config": {
    "model": "inherit",
    "thinking": "high",
    "timeoutMs": 120000,
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
- `timeoutMs`: optional per-child runtime deadline in milliseconds; `0` disables an inherited limit. There is no built-in deadline. See [runtime deadlines](#runtime-deadlines).
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

### Runtime deadlines

`config.timeoutMs` accepts an integer from `0` through `2147483647`. Invalid values fail validation; strings are not coerced. The built-in default is no deadline. Item > call > role > user-default precedence applies; an explicit `0` disables an inherited deadline.

Each child receives its own deadline. The clock starts immediately before runner invocation, after acquiring a process slot and preparing the expanded task/config. Queueing, admission, approval, and task preparation are excluded. Child startup/bootstrap, model requests, tools, and runner finalization are included. This is not a group-wide or per-tool budget; a chain can run longer than one child's limit.

When a deadline expires:

- The affected child is marked `cancelling` with `timedOut: true` and a diagnostic, and receives the existing cancellation/termination sequence. Cleanup can extend beyond `timeoutMs`; process slots and writer reservations are not released merely because the timer fired.
- After runner cleanup, that child has `state: "failed"`, a nonzero `exitCode`, `timedOut: true`, and an `errorMessage` naming the limit. Status and foreground result details expose these fields; retained output reads include the diagnostic.
- Later chain steps are skipped. Parallel siblings keep running; once all items settle, a group with a timed-out child fails unless the group was explicitly cancelled.
- Explicit cancellation before the deadline remains cancellation, not timeout. If the deadline fires first, that child retains the timeout failure even if the group is subsequently cancelled. Normal completion and cancellation clear the child's deadline and parent-abort listener.
- Retained output and reported usage remain available under existing retention/accounting rules. Graceful shutdown summaries can be complete; hard kills or missing summaries must not be reported as complete usage. Background notification and result-delivery rules are unchanged.

**A deadline is not a mutation-safe boundary or rollback.** It can interrupt a write or external action. Use narrow assignments and inspect partial changes before retrying. There is no new OS sandbox, and existing crash/escaped-process cleanup limitations still apply.

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
timeoutMs: 120000
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
| `list` | `action` | Known groups, result-delivery state, and complete extension usage totals. |
| `status` | `action`, `taskId` | Group/item state and activity, result-delivery state, resolved configuration, diagnostics, and usage. |
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

Pages include their starting `cursor`, `view`, `nextCursor`, `totalBytes`, task `state`, and `truncated` flag. Continue with the returned `nextCursor` until it is `null`. Use returned offsets rather than splitting UTF-8 characters yourself. Very small pages may expand to one whole character. A running log is a changing snapshot: read from cursor 0; after completion it can be paged stably.

### Activity inspection

Each child item in foreground/background result details and `status`/`cancel` results exposes:

| Field | Meaning |
| --- | --- |
| `startedAt` | Unix epoch milliseconds immediately before runner invocation, after slot acquisition and task/config preparation. Absent until actually started. |
| `finishedAt` | Unix epoch milliseconds after the runner settles, including runner cleanup. Absent while running and for items never started. |
| `elapsedMs` | Nonnegative runtime from `startedAt` to the current snapshot, or to `finishedAt` after completion. Absent for queued, skipped, or cancelled-before-start items. |
| `currentTool` | Name of the most recently started tool that has not ended, based on child execution events. Absent when no tool is active and in all terminal states. No tool arguments/results are included. |
| `lastEventAt` | Parent receive time of the latest parsed child JSONL event, in Unix epoch milliseconds. Absent before any event; it is **not a heartbeat or proof of process health**. |

Concurrent/nested tools are tracked by call ID; an older tool finishing does not clear a newer active tool. If the newest tool ends first, `currentTool` returns to the latest remaining active one. This field is a compact activity hint, not a complete tool trace. Execution-start events can precede validation, approval, or queue waits for nested calls; they do not prove that the tool implementation is currently executing. Duplicate starts and unmatched ends do not replace active activity. Stderr bytes alone do not update `lastEventAt`.

`list` keeps its group metadata and adds a lightweight `results` array with each item's `itemId`, `agent`, `state`, optional chain `step`, and activity fields above. The existing group-level `startedAt` remains the **admission** time, not a child runtime start. Query snapshots are detached; elapsed time freezes after completion. High-frequency text/tool progress updates are coalesced without dropping accounting records.

In interactive TUI mode, **`/subagents`** opens a local, read-only live view of active/queued items and retained completions, with group IDs, item numbers, start times, runtimes, current tools, last-event ages, and extension usage. Active groups come first. The footer links to this command while work is active or queued, and tool-result rendering includes item activity.

Use the configured select up/down and page-up/page-down keys to scroll; select cancel/confirm or interrupt closes the view (defaults: arrows, Page Up/Page Down, Escape/Enter/Ctrl+C). Opening, scrolling, refreshing, or closing it does not start a model turn, read retained reports/logs, consume completion reminders, or change usage/result-delivery state. Independent background completion notifications retain their existing wakeup behavior. The view shares the session watcher rather than starting a separate refresh timer; refreshing stops once work and pending reminders settle. Tree navigation and session shutdown close it. RPC/JSON/print modes do not construct terminal components; use `subagent_task` list/status there.

### Result delivery

Execution completion, result delivery, and parent acceptance are distinct. `list` and `status` expose `resultDelivered`: the entire retained final output snapshot has reached successful, unchanged, finalized `subagent_task` output results in the parent. This is automatic bookkeeping, not an acknowledgment action or a claim that the parent accepted, verified, or integrated the report.

- Delivery requires every byte from cursor 0 to the end. Overlapping or out-of-order pages can complete coverage; a final page alone does not.
- Status/list queries, log reads, partial output, invalid or aborted reads, and error/redacted tool results do not consume completion reminders.
- Complete output delivery applies equally to successful, failed, and cancelled groups. It consumes only pending reminders, never changes execution status, removes results, extends retention, or charges usage again.
- Truncated output can be delivered completely **as retained**; omitted bytes remain unavailable and a warning is included in the tool result.

Result reads remain repeatable. Foreground delegation still returns output directly and never schedules completion reminders. Delivery bookkeeping described here concerns retained output reads; it is session-local and is not restored after reload/resume.

### Background lifecycle

`background: true` returns a group ID without waiting for the model. Each item also has an `itemId`. Background work is not tied to the launching turn's abort signal.

Completion/failure/explicit cancellation creates an eligible reminder when `notify: true` (the default). While the parent is busy, eligibility stays inside the extension rather than in the host's non-revocable follow-up queue. At `agent_before_settle`, the extension rechecks delivery and batches remaining reminders into one metadata-only continuation. Results already delivered in full do not request a duplicate read or another model turn.

Idle completions still wake the parent automatically. A session-scoped idle recheck covers busy operations such as manual compaction or aborted runs that may not reach the pre-settlement hook. The resulting parent turn can incur model usage. `notify: false` disables automatic reminders and wakeups, not result retrieval.

Notifications contain group IDs, states, expiration markers, and usage metadata, not arbitrary child output as new instructions. They grant no permissions. Retrieve missing results separately; reuse complete results already available and verify them before integration. Notifications are best-effort hints, not a durable delivery protocol. Once handed to the host they cannot be selectively revoked; later delivery bookkeeping does not retract an already-dispatched message. Other extensions can alter context or continuation, so `resultDelivered` is not proof that a provider used the output.

Exit, session switch, and reload clean processes, timers, listeners, delivery bookkeeping, and temporary artifacts. `/tree` navigation cancels active work and suppresses pending reminders from the old branch, including completed groups. Known completed state/results/usage remain queryable subject to retention. Tasks/results are not restored; only the usage ledger is restored. SIGKILL, system crashes, and deliberately detached/escaped processes cannot be guaranteed cleanup. Cancellation does not roll back changes or external actions.

### Parallel writers

All foreground/background groups share **4 process slots**. Active/queued groups reserve at most **32 total items**; an entire group's quota is released only when it ends.

Potential writers in the same Git worktree are rejected by default, including overlap across separate calls. Both overlapping groups must explicitly set `allowSharedWrites: true` to permit it. Sequential chains and independent worktrees are supported. Non-Git workspaces use canonical path/ancestor overlap checks.

Shell tools, unknown custom tools, and MCP loadouts are treated as potentially writable. Workspace checks prevent declared-workspace collisions; they do not constrain tools to that workspace. No worktree creation or automatic merge is provided.

## Usage and retention

The extension ledger is authoritative for reported child calls. **Pi's native `/session` and footer do not include this extension's child usage.** `list` reports session totals; status/rendering expose group/item totals. Queries, progress, and notifications do not charge usage again.

The TUI extension footer counts child items, not `subagent` calls/task groups. `active` includes running and cancelling items; `queued` is shown separately and includes items waiting for a process slot and future chain steps. Completed, failed, cancelled, and skipped items no longer contribute to either count. While items are active/queued, the footer includes the `/subagents` inspection entry point.

Usage includes reported model, tool-embedded model, and compaction usage. Reasoning/cache-write subsets are not double-counted. Failed/cancelled tasks retain known usage. Hard kills/protocol failures can leave server usage unreported: `usageComplete: false` means the total is incomplete, not free. Absolute ledger snapshots persist on completion/normal shutdown; reload/resume restores accounting only.

Artifacts live under a system temporary `pi-subagent-session-*` directory (0700; files 0600):

| Limit | Default |
| --- | --- |
| Log per item | 1 MiB |
| Output per item | 256 KiB |
| Protocol event / display cache | 1 MiB each |
| Active tool activity | 256 calls / 1 MiB of call IDs and names |
| Combined model-visible foreground result | About 50 KiB |
| Result query page | At most 50 KiB |
| Retained completed groups | 16 |
| Retained completed log/output data | 64 MiB |

Oversized protocol events terminate the child with diagnostics. Truncated logs/output are marked; omitted bytes are not retained. Old artifacts can be evicted before session exit. There is no time TTL; bounded expired-state records eventually give way to accounting totals. Configuration snapshots (potentially containing MCP credentials) are removed when an item exits or is skipped; closing the session removes the temporary directory.

## Plan Mode

The extension reads `plan-mode-state` and checks resolved permissions. Plan Mode permits only `read,grep,find,ls`, with no external sources. Entering it cancels existing writers without undoing completed actions. Notifications remain subject to current permissions.

An optional companion at `compat/plan-mode/` supports actual permission checks, task management, and waiting for writer cancellation. Install it explicitly and retain only one `/plan` extension; see [installation](../INSTALL.md#optional-plan-mode-companion).
