# Pi Subagent

独立维护的 Pi subagent 扩展：Markdown 角色、临时配置、单任务/并行/chain，以及会话内后台。

**日常版基线：`v0.1.0`。采用固定发布目录安装，不跟随开发目录；发布、升级和回滚见 [`INSTALL.md`](INSTALL.md)。不要同时加载两个同名 `subagent` 工具。**

已实现核心功能并提供离线测试；实际 TUI 显示及真实模型/订阅还需人工验收。验证版本：Pi 1.1.0、Node 24、macOS。

## 调用接口

### 单任务与临时角色

```json
{
  "task": "检查认证逻辑，不修改文件",
  "config": {
    "model": "inherit",
    "thinking": "high",
    "rolePrompt": {
      "replace": "你是审查员，只报告有证据的问题。",
      "append": "重点检查权限绕过。"
    },
    "tools": { "allow": ["read", "grep", "find", "ls"] }
  },
  "background": true
}
```

也可以使用 `{"agent":"scout","task":"查找认证实现"}`。不必先创建角色文件。

- `rolePrompt.replace` 替换角色指令，`append` 追加到选定角色指令后。
- `systemPrompt` 单独替换 Pi 基础提示词；仍包含明确选定的角色指令和工作目录。工具声明独立通过模型协议发送，权限不依赖提示词。
- 不加载环境中的 `SYSTEM.md`、`APPEND_SYSTEM.md`、上下文文件、skills 或 workflow prompts 到子进程，不复制父会话完整提示词。
- 模型使用准确 `provider/id`，或唯一的准确模型 ID；不做模糊匹配，不静默回退。显式 provider 扩展可引入父会话未知的模型，但必须给准确 `provider/id`，并在子进程加载后通过模型目录校验。
- `model: "inherit"`、`thinking: "inherit"` 在派发时读取父会话值。Pi 会按模型能力限制 thinking，实际值在结果/status 中返回。
- 继承不包含父进程内的临时凭据、运行时 provider 或虚拟模型实现。子进程需要可用凭据/模型配置；必要的 provider 扩展必须显式选择并获信任。

### 并行与 chain

```json
{
  "tasks": [
    { "agent": "scout", "task": "检查模型层" },
    { "agent": "reviewer", "task": "检查路由层" }
  ],
  "background": true
}
```

```json
{
  "chain": [
    { "agent": "scout", "task": "调查认证逻辑" },
    { "agent": "planner", "task": "根据调查制定计划：\n{previous}" }
  ],
  "config": { "thinking": "inherit" }
}
```

恰好选择一种模式。每个子项都支持 `agent? / task / cwd? / config?`；公共 `cwd`、`config` 作用于所有子项。chain 在失败/取消时停止，未执行步骤标为 skipped/cancelled；`{previous}` 传递上一步保留的最终输出（有输出存储上限）。

**优先级：子项配置 > 公共调用配置 > 角色文件 > 用户默认配置 > 内建默认。** 对象按字段合并；数组替换，不合并；空字符串/空数组明确清空。追加指令也是一个配置字段：高优先级 `append` 替换低优先级 `append`，不是多层隐式堆叠。

默认模型/thinking 继承父会话，工具为 `read,bash,edit,write`，无外部工具来源。角色中的字段可独立覆盖这些默认。

相对调用路径从父会话 cwd 解析；角色中的扩展路径从角色文件所在目录解析；子项 cwd 默认继承公共 cwd。相对任务 cwd 也从父会话 cwd 解析。

## Markdown 角色

```markdown
---
name: investigator
description: 只读调查
tools:
  allow: [read, grep, find, ls]
  extensions: []
  mcp: []
model: inherit
thinking: inherit
---

调查仓库并返回可验证的文件路径和证据。不要修改文件。
```

兼容旧 `tools: read, grep` 和 YAML 工具数组。无效 frontmatter 会产生诊断并排除该角色，不把无效工具配置变成全权限。

- 用户角色：`<agent-dir>/agents/*.md`，默认只选用户角色。
- 项目角色：最近祖先目录中的 `.pi/agents/*.md`，须显式 `agentScope: "project"` 或 `"both"`。
- `both` 下项目同名覆盖用户角色；结果/status 记录获选文件、被覆盖文件及每个字段来源。`user:name`、`project:name` 可准确选择，但仍必须在所选 scope 内。
- 未信任项目的角色需要用户确认；无 UI 时拒绝，而不是跳过确认。
- 仓库中的 `agents/` 是待安装示例，扩展不会偷偷自动安装或加载它们。示例默认继承模型；scout/planner/reviewer 不暴露 bash。

## 工具来源与权限

```json
{
  "config": {
    "tools": {
      "allow": ["read", "custom_lookup", "mcp__docs__lookup"],
      "extensions": ["/absolute/path/to/trusted-tools.ts"],
      "mcp": ["docs"]
    }
  },
  "task": "调查问题"
}
```

- `allow` 是准确工具名白名单，不支持通配符、`+/-` 选择器。`[]` 不暴露任何工具。
- `extensions` 是明确的本地文件/带 index 的目录；也支持 `builtin:codemode`、`builtin:tool-search`。MCP 由本扩展控制，不能自行加载 `builtin:mcp`。
- 外部扩展是可执行代码。须在交互 UI 确认，或由用户默认配置列入 `trustedExtensions`。不自动继承父进程扩展。
- `mcp` 明确选择服务器名称：从用户 `mcp.json`、可信且与父 cwd 相同的项目 `mcp.json`、父扩展注册的服务器中取配置快照。只连接选定服务器，不自动继承连接。
- 缺少模型/工具、无效来源、失败的连接会明确报错。异步 MCP 工具最多等待 15 秒；错误保留在任务诊断中。
- 直接、间接、动态启用工具都受实际调用白名单限制；每次模型请求前重设声明工具。`subagent`、`subagent_task` 禁止进入子任务白名单。

**这不是 OS 沙箱。** bash、可信扩展和 MCP 代码仍有宿主权限，能访问其他目录、执行程序或产生加载副作用。递归限制针对 Pi 委托工具，不承诺阻止 bash 启动另一个程序。要限制进程/文件/网络访问，应另外使用容器或 OS 沙箱。

### 用户默认配置

可选 `<agent-dir>/subagent.json`，默认 agent-dir 为 `~/.pi/agent`：

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

只读取用户配置，不自动加载项目 subagent.json。配置每次调用重新读取；相对路径从 agent-dir 解析。

## 会话内后台

`background: true` 完成校验/信任确认/登记后立即返回任务组 ID，不等待模型完成。每个组内的子项都有 itemId。后台不绑定启动回合的 abort signal。

```text
subagent_task({action: "list"})
subagent_task({action: "status", taskId: "…"})
subagent_task({action: "result", taskId: "…", cursor: 0, maxBytes: 16384})
subagent_task({action: "result", taskId: "…", view: "log"})
subagent_task({action: "cancel", taskId: "…"})
```

- 默认完成/失败/显式取消后发送 `followUp`：忙时排队，空闲时自动启动主 agent 新回合。这个主回合会产生模型费用；`notify: false` 关闭完成唤起。
- 通知只发送任务 ID/状态，不把任意子输出作为新指令。它不提升主 agent 当前权限。
- 结果尚未完成时使用 status 或 log；最终结果按返回的 `nextCursor` 分页。游标是字节偏移，须使用返回值，不自行切到 UTF-8 字符中间。极小页可能扩到一个完整字符。
- 运行中 log 是变化的快照，建议从 cursor 0 读取；任务完成后可稳定分页。
- 取消覆盖已运行进程及排队子项。正常退出、切换会话、reload 清理所有进程、计时器、监听器和临时文件；`/tree` 导航也取消活动任务以免把旧分支结果唤起到新分支。
- 不恢复任务、不提供会话外后台。SIGKILL、系统崩溃及主动脱离树的进程不能保证扩展有机会清理。

### 并行写入

每次并行最多 8 个子项；所有前台/后台任务共享 4 个进程槽；未结束任务组占用的子项配额总数最多 32（整个组结束才释放配额）。

同一 Git 工作树内的多个潜在写入子项默认拒绝。多个独立调用之间也检查重叠写任务；双方都必须明确 `allowSharedWrites: true` 才放行。chain 可以顺序写入；独立 worktree 可并行。本扩展不自动创建 worktree、不合并修改。非 Git 路径按真实路径/祖先关系检查。

未知外部工具、MCP、bash 均按潜在写入处理。工作树检查只是避免声明工作区碰撞，不限制工具访问其他路径。

### Usage 与存储

**以扩展账本为准，不写入 Pi 原生 `/session`/页脚的子调用 usage。** `list` 返回会话汇总；status/渲染返回组和子项汇总。每个子项更新的是 usage 快照，查询、进度和通知不重复加账。包含模型、工具内嵌模型、compaction 的已报告 usage；reasoning/cacheWrite1h 是子集，不再加到 output/cacheWrite。

成功、失败、取消路径均保留已报告用量。硬杀/协议错误下无法获知服务端尚未报告的真实费用，标记 `usageComplete: false`，不编造零费用或精确总数。完成和正常 shutdown 持久化绝对账本快照；reload/resume 只恢复账本，不恢复进程或结果。

任务目录为系统临时目录中的 `pi-subagent-session-*`，目录 0700、文件 0600。默认每子项日志 1 MiB、输出 256 KiB、协议事件/显示缓存 1 MiB；超过协议事件上限会终止并诊断。超限的日志/输出明确标记 truncated，省略部分不保留。模型可见结果合计约 50 KiB，查询单页最多 50 KiB。

最多保留 16 个已完成组、64 MiB 的已完成日志/输出；旧数据提前清除。保留少量过期状态，之后只保留汇总用量，不重复记账。没有时间 TTL：数据保留到会话关闭或空间/数量淘汰。未执行步骤和子进程退出后立即删除配置快照（可含 MCP 凭据）；会话关闭删除整个临时目录。

## Plan Mode

扩展读取 `plan-mode-state` 并检查解析后的真实权限；只允许 `read,grep,find,ls`，不能含外部来源。进入 Plan Mode 时取消已有写入任务，不回滚已经执行的动作。通知仍受当前模式限制。

现有 `pi-settings` Plan Mode 按 `type: "explore"` 授权，与新接口不兼容。仓库提供 **可选** `compat/plan-mode.ts` 替换版本，支持任务管理、实际权限检查和进入只读模式时等待写任务停止。它不由 subagent 自动加载；配套安装路径为 `compat/plan-mode/`，保留旧版的证据优先规划流程。安装时一起替换旧 Plan Mode，且只能保留一个 `/plan` 扩展。

## 开发与验收

```bash
npm ci --ignore-scripts
npm run check
npm test
```

依赖仅安装在本仓库供开发测试；Pi 包依赖声明为 peer，运行时由宿主提供。没有运行时依赖安装目录内的示例文件。

测试包括配置/角色/schema、独立 Pi 子进程对接 loopback 假模型及假 MCP、工具越权、UTF-8/协议上限、并发/chain、后台取消、detached 子进程清理、会话生命周期、usage 去重，以及真实父 RPC 在忙碌/空闲时的自动唤起。测试不调用真实模型或修改当前 Pi 安装。

剩余人工验收：真实模型/订阅、忙碌/空闲时的实际 TUI 唤起及显示、真实系统退出/reload 操作；Windows/Linux 尚未做整机验收。

## 文件与来源

- `index.ts` / `schemas.ts`：工具入口、公共参数及会话事件。
- `agents.ts` / `config.ts` / `sources.ts` / `policy.ts`：发现、解析、来源选择和权限。
- `tasks.ts` / `process-runner.ts` / `child.ts`：会话任务、进程树、隔离启动与私有控制管道。
- `render.ts`：单任务/并行/chain 的折叠及展开显示。
- `contracts.ts`：共享数据契约；`tests/`：离线验收。
- `agents/`、`prompts/`：示例角色和官方 workflow prompts。
- `INSTALL.md`：固定版本安装、升级和回滚；`PLAN.md`：已确认决策与剩余验收；`UPSTREAM.md`：原始官方说明，仅作历史参考。

底座来自 `@earendil-works/pi-coding-agent` 1.1.0 的官方 subagent 示例。上游：https://github.com/earendil-works/pi ，MIT，保留许可见 `LICENSE`。后续仅维护本项目副本。
