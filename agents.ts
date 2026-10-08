/** Markdown role discovery. Project roles are never loaded without an explicit scope. */
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { assertKnownKeys, assertObject, assertRunConfig, qualifyConfigPaths } from "./config.ts";
import type { AgentScope, RunConfig, ThinkingLevel } from "./contracts.ts";

export type { AgentScope, RunConfig, ThinkingLevel } from "./contracts.ts";

export interface AgentConfig {
	name: string;
	description: string;
	/** Legacy aliases for the original dispatch. New dispatch should use config/rolePrompt. */
	tools?: string[];
	model?: string;
	/** Legacy appended role prompt, NOT the new base-system replacement. */
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
	rolePrompt?: string;
	config?: RunConfig;
	shadowedFiles?: string[];
	/** Retain overridden user definitions for explicit user:name selection. */
	shadowedAgents?: AgentConfig[];
}

export interface AgentDiagnostic {
	filePath: string;
	source: "user" | "project";
	message: string;
}

export interface AgentDiscoveryResult {
	/** Effective unqualified names. Project winners retain their qualified user alternatives. */
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	diagnostics: AgentDiagnostic[];
}

const FRONTMATTER_KEYS = ["name", "description", "model", "thinking", "systemPrompt", "rolePrompt", "tools"];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseTools(value: unknown): RunConfig["tools"] {
	if (typeof value === "string") {
		// A deliberately empty legacy value means no tools, never the broader defaults.
		if (!value.trim()) return { allow: [] };
		const entries = value.split(",").map((entry) => entry.trim());
		if (entries.some((entry) => !entry)) throw new Error("tools: empty entry in CSV list");
		return { allow: entries };
	}
	if (Array.isArray(value)) {
		if (value.some((entry) => typeof entry !== "string")) throw new Error("tools: expected a list of strings");
		return { allow: value.map((entry: string) => entry.trim()) };
	}
	// Validation below must reject null, scalars and invalid object members.
	return value as RunConfig["tools"];
}

function parseAgent(content: string, source: "user" | "project", filePath: string): AgentConfig {
	const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (!/^---[\t ]*$/.test(lines[0])) throw new Error("missing YAML frontmatter opening delimiter");
	const end = lines.findIndex((line, index) => index > 0 && /^---[\t ]*$/.test(line));
	if (end < 0) throw new Error("unterminated YAML frontmatter (expected a closing --- line)");
	const yaml = lines.slice(1, end).join("\n");
	// Pi's parser recognizes closing-delimiter prefixes. Reject those malformed lines
	// rather than allowing an invalid header to silently discard its restrictive fields.
	if (lines.slice(1, end).some((line) => line.startsWith("---"))) throw new Error("invalid YAML frontmatter delimiter");
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(`---\n${yaml}\n---\n`);
	assertObject(frontmatter, "frontmatter");
	assertKnownKeys(frontmatter, FRONTMATTER_KEYS, "frontmatter");
	if (typeof frontmatter.name !== "string" || !frontmatter.name.trim() || frontmatter.name !== frontmatter.name.trim() || frontmatter.name.includes(":")) {
		throw new Error("name: expected a nonempty, unqualified role name without surrounding whitespace");
	}
	if (typeof frontmatter.description !== "string") throw new Error("description: expected a string");
	const config: RunConfig = {};
	for (const key of ["model", "thinking", "systemPrompt", "rolePrompt", "tools"] as const) {
		if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) continue;
		Object.assign(config, { [key]: key === "tools" ? parseTools(frontmatter[key]) : frontmatter[key] });
	}
	assertRunConfig(config, "frontmatter");
	const rolePrompt = lines.slice(end + 1).join("\n").trim();
	const qualified = qualifyConfigPaths(config, path.dirname(filePath));
	return {
		name: frontmatter.name, description: frontmatter.description, source, filePath,
		rolePrompt, config: qualified, systemPrompt: rolePrompt,
		...(qualified.model !== undefined ? { model: qualified.model } : {}),
		...(qualified.tools?.allow !== undefined ? { tools: [...qualified.tools.allow] } : {}),
		shadowedFiles: [],
	};
}

function loadAgentsFromDir(dir: string, source: "user" | "project", diagnostics: AgentDiagnostic[]): AgentConfig[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push({ filePath: dir, source, message: errorMessage(error) });
		return [];
	}
	const groups = new Map<string, AgentConfig[]>();
	for (const entry of entries) {
		if (!entry.name.toLowerCase().endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const agent = parseAgent(fs.readFileSync(filePath, "utf8"), source, filePath);
			const group = groups.get(agent.name) ?? [];
			group.push(agent);
			groups.set(agent.name, group);
		} catch (error) {
			diagnostics.push({ filePath, source, message: errorMessage(error) });
		}
	}
	const agents: AgentConfig[] = [];
	for (const [name, group] of groups) {
		if (group.length === 1) agents.push(group[0]);
		else for (const agent of group) diagnostics.push({ filePath: agent.filePath, source,
			message: `duplicate ${source} role ${JSON.stringify(name)}: ${group.map((entry) => entry.filePath).join(", ")}` });
	}
	return agents;
}

function isDirectory(dir: string): boolean {
	try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** userDir overrides the agents directory itself, not the enclosing Pi agent directory. */
export function discoverAgents(cwd: string, scope: AgentScope = "user", userDir = path.join(getAgentDir(), "agents")): AgentDiscoveryResult {
	if (scope !== "user" && scope !== "project" && scope !== "both") throw new Error("agentScope: expected user, project, or both");
	const diagnostics: AgentDiagnostic[] = [];
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(path.resolve(userDir), "user", diagnostics);
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", diagnostics);
	const map = new Map<string, AgentConfig>();
	for (const agent of userAgents) map.set(agent.name, agent);
	for (const agent of projectAgents) {
		const shadowed = map.get(agent.name);
		if (shadowed) {
			agent.shadowedFiles = [shadowed.filePath];
			agent.shadowedAgents = [shadowed];
		}
		map.set(agent.name, agent);
	}
	return { agents: [...map.values()], projectAgentsDir, diagnostics };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	const count = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : maxItems === Infinity ? agents.length : 0;
	const listed = agents.slice(0, count);
	return { text: listed.length ? listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; ") : "none",
		remaining: agents.length - listed.length };
}
