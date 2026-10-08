/** Private CLI bootstrap. Loaded LAST, after explicitly trusted tool/provider extensions. */
import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createMcpExtension, type ExtensionAPI, type ExtensionContext, type LoadedMcpConfig, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import { READ_ONLY_TOOLS, RECURSIVE_TOOLS, type ChildConfig } from "./contracts.ts";
import { aggregateUsage, normalizeUsage } from "./process-runner.ts";

function protocol(event: unknown): void {
	// Pi reserves stdout and redirects extension writes to stderr. A dedicated inherited pipe
	// also prevents private control records from interleaving with large native JSONL records.
	fs.writeSync(Number(process.env.PI_SUBAGENT_PROTOCOL_FD ?? "3"), `${JSON.stringify(event)}\n`);
}
async function fatal(message: string): Promise<never> {
	process.stderr.write(`Subagent configuration error: ${message}\n`);
	protocol({ type: "subagent_error", error: message });
	// Do not throw (Pi normally continues after handler errors), or exit immediately
	// (detached MCP children could become orphaned before the parent discovers them).
	// Park this handler until the owning runner terminates the captured process tree.
	return new Promise<never>(() => {});
}
export default async function childGuard(pi: ExtensionAPI): Promise<void> {
	if (process.env.PI_SUBAGENT_CHILD !== "1" || !process.env.PI_SUBAGENT_CONFIG) throw new Error("child.ts is a private bootstrap, not a user extension");
	const config = JSON.parse(fs.readFileSync(process.env.PI_SUBAGENT_CONFIG, "utf8")) as ChildConfig;
	const task = config.task;
	const allowed = new Set(task.tools.allow);
	if ([...allowed].some((name) => RECURSIVE_TOOLS.has(name))) await fatal("recursive delegation is forbidden");
	const serverNames = new Set(config.mcpServers.map((server) => server.name));
	for (const server of pi.getMcpServers()) if (!serverNames.has(server.name)) await fatal(`extension registered unselected MCP server ${server.name}`);
	if (config.mcpServers.length) {
		// Validate without making registrations visible or connecting ambient servers.
		for (const server of config.mcpServers) {
			const existing = pi.getMcpServers().find((entry) => entry.name === server.name);
			if (existing && JSON.stringify(existing.config) !== JSON.stringify(server.config)) await fatal(`selected MCP configuration conflicts with extension registration: ${server.name}`);
			if (!existing) pi.registerMcpServer(server.name, server.config as unknown as McpServerConfig);
		}
		const selected: LoadedMcpConfig = { servers: [], errors: [], autoEnableCodemode: false };
		await createMcpExtension({
			loadConfig: () => selected,
			startupWaitMs: 15_000,
			openUrl: () => fatal("MCP login must be completed in the parent, not from a child"),
			updateConfig: () => { throw new Error("Child MCP configuration is read-only"); },
		})(pi);
	}
	let ready = false;
	const reconcile = () => {
		// Hard call gate below also covers hidden/deferred/nested tools. The declared set
		// is reset before each provider request, even if another extension activates tools.
		pi.setActiveTools([...allowed]);
	};
	pi.on("tool_call", (event) => {
		if (!allowed.has(event.toolName) || RECURSIVE_TOOLS.has(event.toolName)) return { block: true, reason: `Tool ${event.toolName} is outside the subagent allowlist` };
		if (task.readOnly && !READ_ONLY_TOOLS.has(event.toolName)) return { block: true, reason: "Subagent is read-only" };
	});
	pi.on("user_bash", () => ({ result: { output: "Direct shell execution is disabled in subagents", exitCode: 1, cancelled: false, truncated: false } }));
	pi.on("cache_warming_decision", () => ({ action: "stop" }));
	pi.on("before_agent_start", async (event, ctx) => {
		const actual = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		if (!ctx.modelRegistry.getAll().some((model) => `${model.provider}/${model.id}` === task.model)) await fatal(`model is not in the configured catalog: ${task.model}`);
		if (actual !== task.model) await fatal(`expected model ${task.model}, got ${actual ?? "none"}`);
		// Explicit sources may connect asynchronously. Do not start the model until every
		// requested tool exists and is reachable. A timeout is an error, never a fallback.
		const deadline = Date.now() + (config.mcpServers.length ? 15_000 : 0);
		let missing: string[];
		do {
			const available = new Set(pi.getAllTools().filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name));
			missing = [...allowed].filter((name) => !available.has(name));
			if (!missing.length || Date.now() >= deadline) break;
			await delay(50, undefined, { signal: ctx.signal });
		} while (true);
		if (missing!.length) await fatal(`unavailable tools: ${missing!.join(", ")}`);
		reconcile();
		if ([...allowed].some((name) => !pi.getActiveTools().includes(name))) await fatal("requested tools could not be activated");
		// Rebuild the structured prompt rather than append to ambient SYSTEM/APPEND files.
		const prompt = event.systemPromptOptions;
		// Pi 1.1 treats an empty customPrompt as "use defaults". A whitespace-only
		// explicit prefix preserves the caller's empty replacement instead.
		prompt.customPrompt = task.systemPrompt === "" ? " " : task.systemPrompt;
		prompt.forceSystemPrompt = undefined;
		prompt.appendSystemPrompt = task.rolePrompt;
		prompt.contextFiles = [];
		prompt.skills = [];
		prompt.sections = {};
		prompt.promptGuidelines = [];
		prompt.selectedTools = [...allowed];
		prompt.hiddenTools = [];
		prompt.cwd = task.cwd;
		if (!ready) {
			ready = true;
			protocol({ type: "subagent_ready", model: actual, thinking: ctx.thinkingLevel ?? "off", tools: pi.getActiveTools() });
		}
	});
	pi.on("context", () => { reconcile(); });
	pi.on("before_provider_request", async (_event, ctx) => {
		if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== task.model) await fatal(`model changed away from the configured selection: ${task.model}`);
		reconcile();
	});
	function usageSummary(ctx: ExtensionContext, complete: boolean): void {
		const usages = ctx.sessionManager.getEntries().flatMap((entry) => {
			if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
				const normalized = normalizeUsage(entry.message.usage);
				if (entry.message.role === "assistant") { normalized.turns = 1; normalized.contextTokens = normalized.totalTokens; }
				return [normalized];
			}
			if ((entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) return [normalizeUsage(entry.usage)];
			return [];
		});
		const total = aggregateUsage(usages);
		const assistant = [...usages].reverse().find((usage) => usage.turns > 0);
		total.contextTokens = assistant?.contextTokens ?? 0;
		protocol({ type: "subagent_usage", usage: total, complete });
	}
	pi.on("agent_settled", (_event, ctx) => usageSummary(ctx, true));
	pi.on("session_shutdown", (_event, ctx) => usageSummary(ctx, ready));
}
