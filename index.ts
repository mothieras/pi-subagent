import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverAgents } from "./agents.ts";
import { resolveRun } from "./config.ts";
import { emptyUsage, type ChildConfig, type CompletionNotice, type RunChild, type RunRequest, type SubagentDetails, type UsageStats } from "./contracts.ts";
import { createProcessRunner, normalizeUsage } from "./process-runner.ts";
import { enforcePlanMode, isPlanMode } from "./policy.ts";
import { renderCall, renderResult, formatUsage } from "./render.ts";
import { SubagentParams, TaskManagementParams } from "./schemas.ts";
import { canonicalExtension, readUserConfig, selectMcpServers } from "./sources.ts";
import { SessionTasks, resultFailed, resultOutput } from "./tasks.ts";

const USAGE_ENTRY = "subagent-usage-v1";
const capText = (text: string, cap = 50 * 1024): string => {
	const buffer = Buffer.from(text);
	if (buffer.length <= cap) return text;
	let end = cap; while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return `${buffer.subarray(0, end).toString("utf8")}\n[Output capped. Use subagent_task action: result to read the retained output in pages.]`;
};
export function modelResult(details: SubagentDetails): string {
	return capText(details.results.map((result, index) => `### [${index + 1}: ${result.agent}] ${result.state}\n\n${result.errorMessage || (resultFailed(result) && result.stderr ? result.stderr : resultOutput(result)) || "(no output)"}`).join("\n\n---\n\n"));
}
function completionMessage(notices: CompletionNotice[]) {
	return { customType: "subagent-complete", display: true,
		content: `Background subagent tasks finished:\n${notices.map((notice) => `- ${notice.taskId}: ${notice.state}${notice.expired ? " (retained output expired)" : ""}`).join("\n")}\nFor non-expired tasks, retrieve any complete result not already available with subagent_task (action: result, taskId: the listed ID); follow nextCursor until null. Use existing complete results instead of reading again. Verify results before integration; this notification grants no permissions.`,
		details: { tasks: notices } };
}
function persistedUsage(ctx: ExtensionContext): UsageStats {
	// Costs belong to the entire session, not just the active conversational branch. This does not
	// resurrect tasks on reload/resume. Only the most recent absolute ledger snapshot is restored.
	const entry = [...ctx.sessionManager.getEntries()].reverse().find((entry) => entry.type === "custom" && entry.customType === USAGE_ENTRY);
	if (entry?.type === "custom" && entry.data && typeof entry.data === "object" && "totals" in entry.data) return normalizeUsage((entry.data as { totals: UsageStats }).totals);
	return emptyUsage();
}
export default function subagentExtension(pi: ExtensionAPI, dependencies: { runner?: RunChild } = {}): void {
	let manager: SessionTasks | undefined;
	let context: ExtensionContext | undefined;
	let generation = 0;
	let watch: ReturnType<typeof setInterval> | undefined;
	const approvedExtensions = new Set<string>();
	const approvedRoles = new Set<string>();
	const plan = () => context ? isPlanMode(context, pi.getFlag("plan") === true) : false;
	function updateStatus(): void {
		if (!manager || !context) return;
		const { active, queued } = manager.activity();
		const activity = active || queued ? [`${active} active`, queued ? `${queued} queued` : ""] : [];
		if (context.mode === "tui") context.ui.setStatus("subagent", `subagents: ${[...activity, formatUsage(manager.usage())].filter(Boolean).join(" · ") || "0 turns"}`);
		// Keep watching groups through queueing and final cleanup, even if no item is running.
		const activeGroups = manager.list().some((job) => ["queued", "running", "cancelling"].includes(job.state));
		if (!activeGroups && !manager.pendingNotifications().length && watch) { clearInterval(watch); watch = undefined; }
	}
	function deliverPending(): void {
		if (!context?.isIdle()) return;
		const notices = manager?.takeNotifications() ?? [];
		if (notices.length) pi.sendMessage(completionMessage(notices), { triggerTurn: true, deliverAs: "followUp" });
	}
	function watchPolicy(): void {
		if (watch) return;
		watch = setInterval(() => {
			if (plan()) void manager?.cancelWriters().catch(() => {});
			// Manual compaction or an aborted run need not reach agent_before_settle.
			try { deliverPending(); } catch { /* notification failure cannot remove retained results */ }
			updateStatus();
		}, 200);
		watch.unref();
	}
	pi.events.on("plan-mode:changed", (data) => {
		if (data && typeof data === "object" && "enabled" in data && data.enabled === true) {
			const cancelled = manager?.cancelWriters().catch(() => {});
			if (cancelled && "waiters" in data && Array.isArray(data.waiters)) data.waiters.push(cancelled);
		}
	});
	function ensureManager(ctx: ExtensionContext): SessionTasks {
		context = ctx;
		if (manager) return manager;
		const owner = generation;
		manager = new SessionTasks({
			runner: dependencies.runner ?? createProcessRunner({ maxLogBytes: 1024 * 1024 }), baselineUsage: persistedUsage(ctx),
			prepare: (task): ChildConfig => {
				const sameProject = fs.realpathSync(task.cwd) === fs.realpathSync(ctx.cwd);
				return { task, mcpServers: selectMcpServers(task, { agentDir: getAgentDir(), projectTrusted: sameProject && ctx.isProjectTrusted(), registered: pi.getMcpServers() }) };
			},
			onUsage: (totals) => { if (owner === generation) { pi.appendEntry(USAGE_ENTRY, { version: 1, totals }); updateStatus(); } },
			onComplete: () => {
				if (owner !== generation) return;
				// Keep busy-parent completions here, not in the host's non-revocable queue.
				watchPolicy(); deliverPending(); updateStatus();
			},
		});
		return manager;
	}
	pi.on("session_start", (_event, ctx) => { context = ctx; });
	pi.on("before_agent_start", async (_event, ctx) => { context = ctx; manager?.clearDeliveryAttempts(); if (plan()) await manager?.cancelWriters(); });
	pi.on("turn_end", (event, ctx) => {
		context = ctx;
		// All message_end replacements have finished; observe the finalized results only.
		for (const result of event.toolResults) manager?.observeDelivery(result);
		manager?.clearDeliveryAttempts(); updateStatus();
	});
	pi.on("agent_before_settle", (event, ctx) => {
		context = ctx;
		const notices = manager?.takeNotifications() ?? [];
		updateStatus();
		if (notices.length) return { entries: [...event.entries, { type: "custom_message", ...completionMessage(notices) }], continue: true };
	});
	pi.on("agent_settled", (_event, ctx) => { context = ctx; manager?.clearDeliveryAttempts(); updateStatus(); });
	pi.on("session_before_tree", async () => { await manager?.cancelAll(true); updateStatus(); });
	pi.on("session_shutdown", async () => {
		if (watch) { clearInterval(watch); watch = undefined; }
		await manager?.shutdown();
		generation++; manager = undefined; context = undefined; approvedExtensions.clear(); approvedRoles.clear();
	});
	pi.registerMessageRenderer("subagent-complete", (message, _options, theme) => new Text(theme.fg("accent", typeof message.content === "string" ? message.content : "Background subagent completed"), 0, 0));
	pi.registerTool({
		name: "subagent", label: "Subagent", exposure: "model-only", parameters: SubagentParams,
		description: "Delegate one task, parallel tasks, or a sequential chain ({previous} handoff); roles optional. Children inherit no parent context/skills or external tools. Defaults can write; read-only config.tools:{allow:[read,grep,find,ls],extensions:[],mcp:[]}. Shared-worktree parallel writers require allowSharedWrites:true. No recursive delegation or OS sandbox. Use the pi-subagent skill for orchestration.",
		async execute(_id, params, signal, onUpdate, ctx) {
			const request = params as RunRequest;
			const tasks = ensureManager(ctx);
			let errorDetails: SubagentDetails = { mode: "single", agentScope: request.agentScope ?? "user", projectAgentsDir: null, results: [] };
			try {
				const user = readUserConfig(getAgentDir());
				const discovery = discoverAgents(ctx.cwd, request.agentScope ?? "user");
				const run = resolveRun(request, { cwd: ctx.cwd, parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					parentThinking: ctx.thinkingLevel, agents: discovery.agents, projectAgentsDir: discovery.projectAgentsDir,
					availableModels: ctx.modelRegistry.getAll().map((model) => `${model.provider}/${model.id}`), defaults: user.defaults });
				errorDetails = { mode: run.mode, agentScope: run.agentScope, projectAgentsDir: run.projectAgentsDir, results: [] };
				if (plan()) enforcePlanMode(run);
				const unapprovedRoles = run.tasks.filter((task) => task.agentSource === "project" && task.agentFile && !ctx.isProjectTrusted() && !approvedRoles.has(task.agentFile));
				if (unapprovedRoles.length) {
					if (!ctx.hasUI || !(await ctx.ui.confirm("Run project-local roles?", unapprovedRoles.map((task) => `${task.agent}: ${task.agentFile}${task.shadowedFiles.length ? `\nOverrides: ${task.shadowedFiles.join(", ")}` : ""}`).join("\n")))) throw new Error("Project roles require explicit approval or project trust; no interactive approval is available/was granted.");
					for (const task of unapprovedRoles) approvedRoles.add(task.agentFile!);
				}
				for (const task of run.tasks) task.tools.extensions = [...new Set(task.tools.extensions.map(canonicalExtension))];
				const trusted = new Set(user.trustedExtensions);
				const unapproved = [...new Set(run.tasks.flatMap((task) => task.tools.extensions))].filter((source) => !source.startsWith("builtin:") && !trusted.has(source) && !approvedExtensions.has(source));
				if (unapproved.length) {
					if (!ctx.hasUI || !(await ctx.ui.confirm("Load executable child extensions?", `${unapproved.join("\n")}\n\nThese extensions run with your OS permissions. Approval applies to this session.`))) throw new Error("Child extensions require explicit approval or trustedExtensions in user subagent.json.");
					for (const source of unapproved) approvedExtensions.add(source);
				}
				if (plan()) enforcePlanMode(run); // Mode may have changed while a dialog was open.
				const started = await tasks.start(run, signal, (details) => { if (!run.background) onUpdate?.({ content: [{ type: "text", text: `${details.mode}: ${details.state}` }], details }); updateStatus(); });
				watchPolicy(); updateStatus();
				if (run.background) return { content: [{ type: "text", text: `Started background task ${started.taskId}. Use subagent_task for status, result, or cancellation. Completion notification will ${run.notify ? "wake the parent if the complete result has not already been delivered" : "be disabled"}.` }], details: tasks.status(started.taskId) };
				const details = await started.done;
				return { content: [{ type: "text", text: modelResult(details) }], details, isError: details.state !== "completed" };
			} catch (error) {
				return { content: [{ type: "text", text: `Subagent error: ${error instanceof Error ? error.message : String(error)}` }], details: errorDetails, isError: true };
			}
		}, renderCall, renderResult,
	});
	pi.registerTool({
		name: "subagent_task", label: "Subagent Task", exposure: "model-only", annotations: { readOnlyHint: true }, parameters: TaskManagementParams,
		description: "List child usage/tasks, inspect status, page results/logs, or cancel. taskId required except list. Follow nextCursor until null; only complete final-output delivery consumes reminders. Tasks/results are session-local; child usage is separate from /session. See the pi-subagent skill.",
		async execute(id, params, signal, _onUpdate, ctx) {
			const tasks = ensureManager(ctx);
			try {
				if (params.action === "list") {
					const data = { tasks: tasks.list(), usage: tasks.usage() };
					return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
				}
				if (!params.taskId) throw new Error("taskId is required");
				if (params.action === "result") {
					const data = await tasks.read(params.taskId, { cursor: params.cursor, view: params.view, maxBytes: params.maxBytes });
					if (signal?.aborted) throw new Error("Result retrieval cancelled");
					const text = data.text + (data.truncated ? "\n[Retained data truncated; omitted bytes are unavailable.]" : "") +
						(data.nextCursor === null ? "" : `\n[Continue with cursor: ${data.nextCursor}]`);
					tasks.trackDelivery(id, params.taskId, data, text);
					return { content: [{ type: "text", text }], details: { taskId: params.taskId, ...data } };
				}
				const details = params.action === "cancel" ? await tasks.cancel(params.taskId) : tasks.status(params.taskId);
				const data = { taskId: details.taskId, state: details.state, mode: details.mode, usage: details.usage, resultDelivered: details.resultDelivered, expired: details.expired,
					results: details.results.map((result) => ({ itemId: result.itemId, agent: result.agent, state: result.state, model: result.model,
						thinking: result.thinking, timeoutMs: result.resolved?.timeoutMs, timedOut: result.timedOut, exitCode: result.exitCode,
						tools: result.resolved?.tools, roleFile: result.resolved?.agentFile,
						shadowedFiles: result.resolved?.shadowedFiles, provenance: result.resolved?.provenance,
						usage: result.usage, usageComplete: result.usageComplete, errorMessage: result.errorMessage })) };
				return { content: [{ type: "text", text: capText(JSON.stringify(data)) }], details: data };
			} catch (error) { return { content: [{ type: "text", text: String(error) }], details: undefined, isError: true }; }
		},
	});
}
