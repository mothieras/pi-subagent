import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverAgents } from "./agents.ts";
import { resolveRun } from "./config.ts";
import { emptyUsage, type ChildConfig, type RunChild, type RunRequest, type SubagentDetails, type UsageStats } from "./contracts.ts";
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
		const active = manager.list().filter((job) => ["queued", "running", "cancelling"].includes(job.state)).length;
		if (context.mode === "tui") context.ui.setStatus("subagent", active ? `subagents: ${active} active · ${formatUsage(manager.usage())}` : `subagents: ${formatUsage(manager.usage()) || "0 turns"}`);
		if (!active && watch) { clearInterval(watch); watch = undefined; }
	}
	function watchPolicy(): void {
		if (watch) return;
		watch = setInterval(() => { if (plan()) void manager?.cancelWriters().catch(() => {}); updateStatus(); }, 200);
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
			onComplete: (details) => {
				if (owner !== generation) return;
				// Do not inject arbitrary child output as a new instruction. This notification grants
				// no permissions; the parent's current Plan Mode and tool gates remain in force.
				pi.sendMessage({ customType: "subagent-complete", content: `Background subagent task ${details.taskId} ${details.state}. Read its retained result with subagent_task (action: result, taskId: ${details.taskId}).`, display: true,
					details: { taskId: details.taskId, state: details.state, usage: details.usage } }, { triggerTurn: true, deliverAs: "followUp" });
			},
		});
		return manager;
	}
	pi.on("session_start", (_event, ctx) => { context = ctx; });
	pi.on("before_agent_start", async (_event, ctx) => { context = ctx; if (plan()) await manager?.cancelWriters(); });
	pi.on("session_before_tree", async () => { await manager?.cancelAll(true); });
	pi.on("session_shutdown", async () => {
		if (watch) { clearInterval(watch); watch = undefined; }
		await manager?.shutdown();
		generation++; manager = undefined; context = undefined; approvedExtensions.clear(); approvedRoles.clear();
	});
	pi.registerMessageRenderer("subagent-complete", (message, _options, theme) => new Text(theme.fg("accent", typeof message.content === "string" ? message.content : "Background subagent completed"), 0, 0));
	pi.registerTool({
		name: "subagent", label: "Subagent", exposure: "model-only", parameters: SubagentParams,
		description: "Delegate isolated tasks to any Markdown role or inline configuration. Exactly one of task, tasks (parallel), chain ({previous} substitution). Overrides configure model, thinking, role/base prompts and exact tools with explicit trusted sources. Default role scope user. background:true returns a session task ID and auto-notifies on completion. No recursive delegation. Parallel writers sharing a worktree require allowSharedWrites:true.",
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
				if (run.background) return { content: [{ type: "text", text: `Started background task ${started.taskId}. Use subagent_task for status, result, or cancellation. Completion notification will ${run.notify ? "wake the parent automatically" : "be disabled"}.` }], details: tasks.status(started.taskId) };
				const details = await started.done;
				return { content: [{ type: "text", text: modelResult(details) }], details, isError: details.state !== "completed" };
			} catch (error) {
				return { content: [{ type: "text", text: `Subagent error: ${error instanceof Error ? error.message : String(error)}` }], details: errorDetails, isError: true };
			}
		}, renderCall, renderResult,
	});
	pi.registerTool({
		name: "subagent_task", label: "Subagent Task", exposure: "model-only", annotations: { readOnlyHint: true }, parameters: TaskManagementParams,
		description: "Manage session-local subagent tasks: list (includes complete extension usage totals), status, paginated result (view output or log), cancel. Queries/notifications never charge usage again. Results/logs are private temporary files, cleared on exit/switch/reload and bounded by retention limits. Native Pi /session totals do not include this extension's child calls.",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const tasks = ensureManager(ctx);
			try {
				if (params.action === "list") {
					const data = { tasks: tasks.list(), usage: tasks.usage() };
					return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
				}
				if (!params.taskId) throw new Error("taskId is required");
				if (params.action === "result") {
					const data = await tasks.read(params.taskId, { cursor: params.cursor, view: params.view, maxBytes: params.maxBytes });
					return { content: [{ type: "text", text: data.text + (data.nextCursor === null ? "" : `\n[Continue with cursor: ${data.nextCursor}]`) }], details: { taskId: params.taskId, ...data } };
				}
				const details = params.action === "cancel" ? await tasks.cancel(params.taskId) : tasks.status(params.taskId);
				const data = { taskId: details.taskId, state: details.state, mode: details.mode, usage: details.usage,
					results: details.results.map((result) => ({ itemId: result.itemId, agent: result.agent, state: result.state, model: result.model,
						thinking: result.thinking, tools: result.resolved?.tools, roleFile: result.resolved?.agentFile,
						shadowedFiles: result.resolved?.shadowedFiles, provenance: result.resolved?.provenance,
						usage: result.usage, usageComplete: result.usageComplete, errorMessage: result.errorMessage })) };
				return { content: [{ type: "text", text: capText(JSON.stringify(data)) }], details: data };
			} catch (error) { return { content: [{ type: "text", text: String(error) }], details: undefined, isError: true }; }
		},
	});
}
