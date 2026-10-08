# 日常版本安装

日常版基线：`v0.1.1`。版本号表示可复现的安装基线，不保证没有 bug；后续仍按测试、提交、发布、安装迭代。

## 固定发布版本，而不是跟随开发目录

本机采用 Git detached worktree 发布目录：

```text
~/.pi/agent/local-releases/pi-subagent/v0.1.1/
```

该目录固定到发布 tag 的 commit，没有独立安装 node_modules；运行依赖由 Pi 宿主提供。日常版本代码不要直接修改。开发在 `~/projects/pi-subagent`，修改不会自动进入已安装版本。

安装资源：

- `~/.pi/agent/extensions/subagent` → 发布目录。
- `~/.pi/agent/extensions/plan-mode` → 发布目录的 `compat/plan-mode/`。
- `~/.pi/agent/agents/{scout,planner,reviewer,worker}.md` → 发布角色文件。
- `~/.pi/agent/prompts/{implement,implement-and-review,scout-and-plan}.md` → 发布 workflow。

保留一个 subagent、一个 Plan Mode。不要同时启用旧实现或另外将本包加入 settings.packages，否则可能重复加载。旧 `pi-settings` 实现保留原样。

安装记录保存在 `~/.pi/agent/local-releases/pi-subagent/installations/`，不放在自动发现的 extensions 目录里。记录包含旧链接目标、发布版本/commit 和新增链接，供回滚用；不复制凭据。

## 激活

安装链接切换后，当前 Pi 会话仍持有旧工具定义。完成当前回合后运行 `/reload`，或开启新 Pi 会话。

新版调用不再使用 `type: general/explore`，而是 `task` 或 `tasks` 或 `chain`，配合任意 `agent?` 和 `config?`。不自动继承父进程扩展/MCP。

## 后续更新

1. 在开发仓库修改、运行 `npm run check && npm test`，然后提交。
2. 更新 package.json/lockfile 版本并建立新的发布 tag，不移动旧 tag。
3. 创建新 worktree，例如：
   ```sh
   git worktree add --detach "$HOME/.pi/agent/local-releases/pi-subagent/v0.1.2" v0.1.2
   ```
4. 记录旧链接目标，将两项扩展和已安装示例角色/workflow 一起切到新版本。不要覆盖已有自定义角色/文件。
5. 新会话检查实际模型、前后台、usage、Plan Mode；随后 `/reload` 使用新版。

旧发布目录先保留。需要清理时用 `git worktree remove`，先确认没有安装链接或活动会话指向它；不要直接删除版本目录。

## 回滚

从安装记录恢复旧 subagent 与 Plan Mode 链接；只移除仍指向该次发布、且由该次安装新增的角色/workflow 链接。不要删除或覆盖后来用户修改的文件。然后 `/reload` 或新开会话。

回滚不会撤销模型已执行的文件修改、外部动作或用量。

## v0.1.1 安装修复

`v0.1.0` 的显式目录加载通过，但全局目录符号链接发现会使 `../plan-mode.ts` 从别名目录解析到错误位置。首次安装检查捕获后已回滚。`v0.1.1` 将 Plan Mode 实现放在目录内，不跨符号链接目录向上导入；新增真实 Pi 常规目录发现回归测试。保留原 tag/发布目录，不改写发布历史。
