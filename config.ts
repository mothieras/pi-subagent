import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import { READ_ONLY_TOOLS, RECURSIVE_TOOLS } from "./contracts.ts";
import type { AgentScope, ResolvedRun, ResolvedTask, RunConfig, RunRequest, TaskInput, ThinkingLevel } from "./contracts.ts";

export type { AgentScope, ResolvedRun, ResolvedTask, RunConfig, RunRequest, TaskInput, ThinkingLevel } from "./contracts.ts";

export interface ResolveEnvironment {
	cwd: string;
	parentModel?: string;
	parentThinking?: ThinkingLevel;
	agents: AgentConfig[];
	projectAgentsDir?: string | null;
	defaults?: RunConfig;
	/** Exact, canonical provider/id names of models available to the parent. */
	availableModels?: string[];
}

export const MAX_PARALLEL_TASKS = 8;
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CONFIG_KEYS = ["model", "thinking", "rolePrompt", "systemPrompt", "tools"];
const TOOL_KEYS = ["allow", "extensions", "mcp"] as const;
const REQUEST_KEYS = ["agent", "task", "tasks", "chain", "config", "cwd", "agentScope", "background", "notify", "allowSharedWrites"];
const ITEM_KEYS = ["agent", "task", "cwd", "config"];
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isCanonicalModel = (value: unknown): value is string => typeof value === "string" && /^[^/\s]+\/\S+$/.test(value);

function fail(label: string, message: string): never {
	throw new Error(`${label}: ${message}`);
}

export function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
		fail(label, "expected an object");
	}
}

export function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	for (const key of Object.keys(value)) if (!keys.includes(key)) fail(label, `unknown property ${JSON.stringify(key)}`);
}

function assertString(value: unknown, label: string, nonempty = false): asserts value is string {
	if (typeof value !== "string") fail(label, "expected a string");
	if (nonempty && !value.trim()) fail(label, "must not be empty");
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
	assertString(value, label, true);
	if (value !== value.trim()) fail(label, "must not have leading or trailing whitespace");
}

/** Runtime checks are deliberately independent of TypeBox/tool-call validation. */
export function assertRunConfig(value: unknown, label = "config"): asserts value is RunConfig {
	assertObject(value, label);
	assertKnownKeys(value, CONFIG_KEYS, label);
	if (own(value, "model")) assertString(value.model, `${label}.model`);
	if (own(value, "thinking") && value.thinking !== "inherit" && !THINKING_LEVELS.includes(value.thinking as ThinkingLevel)) {
		fail(`${label}.thinking`, `expected inherit or one of ${THINKING_LEVELS.join(", ")}`);
	}
	if (own(value, "systemPrompt")) assertString(value.systemPrompt, `${label}.systemPrompt`);
	if (own(value, "rolePrompt")) {
		assertObject(value.rolePrompt, `${label}.rolePrompt`);
		assertKnownKeys(value.rolePrompt, ["replace", "append"], `${label}.rolePrompt`);
		for (const key of ["replace", "append"]) {
			if (own(value.rolePrompt, key)) assertString(value.rolePrompt[key], `${label}.rolePrompt.${key}`);
		}
	}
	if (own(value, "tools")) {
		assertObject(value.tools, `${label}.tools`);
		assertKnownKeys(value.tools, TOOL_KEYS, `${label}.tools`);
		for (const key of TOOL_KEYS) {
			if (!own(value.tools, key)) continue;
			const entries = value.tools[key];
			if (!Array.isArray(entries)) fail(`${label}.tools.${key}`, "expected an array of strings");
			for (let i = 0; i < entries.length; i++) {
				const entry: unknown = entries[i];
				const entryLabel = `${label}.tools.${key}[${i}]`;
				assertIdentifier(entry, entryLabel);
				if (key === "allow") {
					if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(entry)) fail(entryLabel, "expected an exact tool name, not a pattern or +/- selector");
					if (RECURSIVE_TOOLS.has(entry)) fail(entryLabel, `recursive delegation tool ${JSON.stringify(entry)} is not allowed`);
				}
				if (key === "mcp" && !/^[a-zA-Z0-9_-]+$/.test(entry)) fail(entryLabel, "expected an MCP server name");
				if (key === "extensions" && entry.includes("\0")) fail(entryLabel, "path contains a null byte");
			}
		}
	}
}

function assertScope(value: unknown): asserts value is AgentScope {
	if (value !== "user" && value !== "project" && value !== "both") fail("agentScope", "expected user, project, or both");
}

function assertItem(value: unknown, label: string): asserts value is TaskInput {
	assertObject(value, label);
	assertKnownKeys(value, ITEM_KEYS, label);
	assertString(value.task, `${label}.task`, true);
	if (own(value, "agent")) assertIdentifier(value.agent, `${label}.agent`);
	if (own(value, "cwd")) assertIdentifier(value.cwd, `${label}.cwd`);
	if (own(value, "config")) assertRunConfig(value.config, `${label}.config`);
}

function validateRequest(value: unknown): ResolvedRun["mode"] {
	assertObject(value, "request");
	assertKnownKeys(value, REQUEST_KEYS, "request");
	// Presence, not truthiness: even an empty or undefined conflicting key is a conflict.
	const single = own(value, "agent") || own(value, "task");
	const parallel = own(value, "tasks");
	const chain = own(value, "chain");
	if (Number(single) + Number(parallel) + Number(chain) !== 1) fail("request", "provide exactly one mode: task, tasks, or chain");
	if (own(value, "agentScope")) assertScope(value.agentScope);
	if (own(value, "cwd")) assertIdentifier(value.cwd, "request.cwd");
	if (own(value, "config")) assertRunConfig(value.config, "request.config");
	for (const key of ["background", "notify", "allowSharedWrites"]) {
		if (own(value, key) && typeof value[key] !== "boolean") fail(`request.${key}`, "expected a boolean");
	}
	if (single) {
		assertString(value.task, "request.task", true);
		if (own(value, "agent")) assertIdentifier(value.agent, "request.agent");
		return "single";
	}
	const key = parallel ? "tasks" : "chain";
	const items = value[key];
	if (!Array.isArray(items) || items.length === 0) fail(`request.${key}`, "expected a nonempty array");
	if (parallel && items.length > MAX_PARALLEL_TASKS) fail("request.tasks", `at most ${MAX_PARALLEL_TASKS} parallel tasks are allowed`);
	for (let i = 0; i < items.length; i++) assertItem(items[i], `request.${key}[${i}]`);
	return parallel ? "parallel" : "chain";
}

function absolutePath(value: string, base: string): string {
	if (value.includes("\0")) fail("path", "contains a null byte");
	const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
	return path.resolve(base, expanded);
}

function directory(value: string, base: string, label: string): string {
	assertIdentifier(value, label);
	const result = absolutePath(value, base);
	try {
		if (!fs.statSync(result).isDirectory()) fail(label, `${JSON.stringify(result)} is not a directory`);
	} catch (error) {
		fail(label, `cannot use directory ${JSON.stringify(result)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return result;
}

/** Qualify each layer BEFORE merging, so surviving paths retain their source directory. */
export function qualifyConfigPaths(config: RunConfig, base: string): RunConfig {
	return {
		...config,
		...(config.rolePrompt !== undefined ? { rolePrompt: { ...config.rolePrompt } } : {}),
		...(config.tools !== undefined ? {
			tools: {
				...config.tools,
				...(config.tools.allow !== undefined ? { allow: [...config.tools.allow] } : {}),
				...(config.tools.mcp !== undefined ? { mcp: [...config.tools.mcp] } : {}),
				...(config.tools.extensions !== undefined ? { extensions: config.tools.extensions.map((entry) => entry.startsWith("builtin:") ? entry : absolutePath(entry, base)) } : {}),
			},
		} : {}),
	};
}

function roleConfigs(agents: AgentConfig[]): AgentConfig[] {
	return agents.flatMap((agent) => [agent, ...(agent.shadowedAgents ?? [])]);
}

function selectAgent(name: string, scope: AgentScope, agents: AgentConfig[]): AgentConfig {
	const qualified = /^(user|project):(.+)$/.exec(name);
	const source = qualified?.[1];
	const bare = qualified?.[2] ?? name;
	if (source && scope !== "both" && scope !== source) fail("agent", `${JSON.stringify(name)} is outside agentScope ${JSON.stringify(scope)}`);
	const eligible = roleConfigs(agents).filter((agent) => (scope === "both" || agent.source === scope) &&
		agent.name === bare && (!source || agent.source === source));
	// An unqualified name in both always selects the project role.
	const preferred = !source && scope === "both" && eligible.some((agent) => agent.source === "project")
		? eligible.filter((agent) => agent.source === "project") : eligible;
	if (!preferred.length) fail("agent", `unavailable agent ${JSON.stringify(name)} in scope ${JSON.stringify(scope)}`);
	if (preferred.length !== 1) fail("agent", `ambiguous agent ${JSON.stringify(name)}; use a unique role definition`);
	return preferred[0];
}

function resolveModel(name: string | undefined, environment: ResolveEnvironment, childSources = false): string {
	if (name === undefined) fail("model", "no parent model is available to inherit; specify config.model");
	assertIdentifier(name, "model");
	// Without a registry, only the parent's known model can be verified. Never guess.
	const available = [...new Set(environment.availableModels ?? (isCanonicalModel(environment.parentModel) ? [environment.parentModel] : []))];
	if (available.includes(name)) return name;
	const matches = available.filter((candidate) => candidate.slice(candidate.indexOf("/") + 1) === name);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) fail("model", `ambiguous model ${JSON.stringify(name)}; specify provider/id (${matches.join(", ")})`);
	// An explicitly selected provider extension may introduce a model unknown to the parent.
	// Only canonical names can defer validation; the private child checks its loaded catalog.
	if (childSources && isCanonicalModel(name)) return name;
	fail("model", `unavailable model ${JSON.stringify(name)}; use an exact available provider/id or unique exact model ID`);
}

/** Objects merge by leaf, arrays replace. Provenance labels: defaults, role, call, item,
 * parent (for inheritance), environment (cwd), and request (task/agent/run options). */
export function resolveRun(request: RunRequest, environment: ResolveEnvironment): ResolvedRun {
	const mode = validateRequest(request);
	const scope = request.agentScope ?? "user";
	const invocationCwd = directory(environment.cwd, process.cwd(), "environment.cwd");
	if (!Array.isArray(environment.agents)) fail("environment.agents", "expected an array");
	if (environment.parentThinking !== undefined && !THINKING_LEVELS.includes(environment.parentThinking)) fail("parentThinking", "invalid thinking level");
	if (environment.availableModels !== undefined) {
		if (!Array.isArray(environment.availableModels) || [...environment.availableModels].some((name) => !isCanonicalModel(name))) {
			fail("availableModels", "expected an array of canonical provider/id strings");
		}
	}
	const defaults: RunConfig = { model: "inherit", thinking: "inherit", rolePrompt: { replace: "" }, tools: { allow: ["read", "bash", "edit", "write"], extensions: [], mcp: [] } };
	if (environment.defaults !== undefined) assertRunConfig(environment.defaults, "defaults");
	const callCwd = request.cwd !== undefined ? directory(request.cwd, invocationCwd, "request.cwd") : invocationCwd;
	const items: TaskInput[] = mode === "single" ? [{ task: request.task!, ...(request.agent !== undefined ? { agent: request.agent } : {}) }]
		: mode === "parallel" ? request.tasks! : request.chain!;

	const tasks = items.map((item): ResolvedTask => {
		const agent = item.agent !== undefined ? selectAgent(item.agent, scope, environment.agents) : undefined;
		const provenance: Record<string, string> = {};
		const merged: RunConfig = {};
		const merge = (config: RunConfig, source: string): void => {
			for (const key of ["model", "thinking", "systemPrompt"] as const) {
				if (config[key] !== undefined) {
					Object.assign(merged, { [key]: config[key] });
					provenance[key] = source;
				}
			}
			for (const key of ["rolePrompt", "tools"] as const) {
				if (config[key] === undefined) continue;
				Object.assign(merged, { [key]: { ...merged[key], ...config[key] } });
				for (const leaf of Object.keys(config[key]!)) provenance[`${key}.${leaf}`] = source;
			}
		};
		merge(defaults, "defaults");
		if (environment.defaults !== undefined) merge(qualifyConfigPaths(environment.defaults, invocationCwd), "defaults");
		if (agent) {
			// Legacy manually-constructed AgentConfig values are still accepted. New discovery
			// stores the base-system replacement ONLY in config.systemPrompt, not this alias.
			const body = agent.rolePrompt ?? agent.systemPrompt;
			assertString(body, `agent ${agent.name}.rolePrompt`);
			const roleConfig = agent.config ?? {
				...(agent.model !== undefined ? { model: agent.model } : {}),
				...(agent.tools !== undefined ? { tools: { allow: agent.tools } } : {}),
			};
			assertRunConfig(roleConfig, `agent ${agent.name}.config`);
			merge(qualifyConfigPaths({ ...roleConfig, rolePrompt: { replace: body, ...roleConfig.rolePrompt } }, path.dirname(agent.filePath)), "role");
		}
		if (request.config !== undefined) merge(qualifyConfigPaths(request.config, invocationCwd), "call");
		if (item.config !== undefined) merge(qualifyConfigPaths(item.config, invocationCwd), "item");
		provenance["model.selection"] = provenance.model;
		provenance["thinking.selection"] = provenance.thinking;
		const inheritedModel = merged.model === "inherit";
		const model = resolveModel(inheritedModel ? environment.parentModel : merged.model, environment, merged.tools!.extensions!.length > 0);
		provenance["model.validation"] = (environment.availableModels ?? [environment.parentModel]).includes(model) ? "parent-catalog" : "child-source";
		if (inheritedModel) provenance.model = "parent";
		const thinking = merged.thinking === "inherit" ? environment.parentThinking ?? "off" : merged.thinking!;
		if (merged.thinking === "inherit") provenance.thinking = environment.parentThinking === undefined ? "defaults" : "parent";
		const replace = merged.rolePrompt!.replace!;
		const append = merged.rolePrompt!.append;
		const rolePrompt = append === undefined || append === "" ? replace : replace ? `${replace}\n\n${append}` : append;
		provenance.rolePrompt = append ? `${provenance["rolePrompt.replace"]}+${provenance["rolePrompt.append"]}` : provenance["rolePrompt.replace"];
		provenance.cwd = item.cwd !== undefined ? "item" : request.cwd !== undefined ? "call" : "environment";
		provenance.agent = item.agent !== undefined ? "request" : "defaults";
		provenance.task = "request";
		const cwd = item.cwd !== undefined ? directory(item.cwd, invocationCwd, "task.cwd") : callCwd;
		const tools = { allow: [...merged.tools!.allow!], extensions: [...merged.tools!.extensions!], mcp: [...merged.tools!.mcp!] };
		const shadowedFiles = [...(agent?.shadowedFiles ?? [])];
		if (agent?.source === "project" && scope === "both") {
			for (const other of roleConfigs(environment.agents)) {
				if (other.name === agent.name && other.source === "user" && !shadowedFiles.includes(other.filePath)) shadowedFiles.push(other.filePath);
			}
		}
		return {
			agent: agent?.name ?? "inline", agentSource: agent?.source ?? "inline",
			...(agent ? { agentFile: agent.filePath } : {}), shadowedFiles,
			task: item.task, cwd, model, thinking, rolePrompt,
			...(merged.systemPrompt !== undefined ? { systemPrompt: merged.systemPrompt } : {}), tools,
			readOnly: tools.allow.every((tool) => READ_ONLY_TOOLS.has(tool)) && tools.extensions.length === 0 && tools.mcp.length === 0,
			provenance,
		};
	});
	return { mode, agentScope: scope, projectAgentsDir: environment.projectAgentsDir ?? null, tasks,
		background: request.background ?? false, notify: request.notify ?? true, allowSharedWrites: request.allowSharedWrites ?? false };
}
