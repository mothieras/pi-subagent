import * as fs from "node:fs";
import * as path from "node:path";
import type { RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { assertKnownKeys, assertObject, assertRunConfig, qualifyConfigPaths } from "./config.ts";
import type { ChildConfig, ResolvedTask, RunConfig } from "./contracts.ts";

export interface UserConfig { defaults?: RunConfig; trustedExtensions: string[] }
export function readUserConfig(agentDir: string): UserConfig {
	const file = path.join(agentDir, "subagent.json");
	if (!fs.existsSync(file)) return { trustedExtensions: [] };
	const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
	assertObject(raw, file);
	assertKnownKeys(raw, ["defaults", "trustedExtensions"], file);
	if (raw.defaults !== undefined) assertRunConfig(raw.defaults, `${file}.defaults`);
	if (raw.trustedExtensions !== undefined && (!Array.isArray(raw.trustedExtensions) || raw.trustedExtensions.some((v) => typeof v !== "string"))) {
		throw new Error(`${file}: trustedExtensions must be a string array`);
	}
	return {
		...(raw.defaults ? { defaults: qualifyConfigPaths(raw.defaults as RunConfig, agentDir) } : {}),
		trustedExtensions: (qualifyConfigPaths({ tools: { extensions: raw.trustedExtensions as string[] | undefined ?? [] } }, agentDir).tools?.extensions ?? []).map(canonicalExtension),
	};
}
export function canonicalExtension(value: string): string {
	if (value === "builtin:codemode" || value === "builtin:tool-search") return value;
	if (value.startsWith("builtin:")) throw new Error(`Unsupported child built-in extension: ${value}`);
	const resolved = fs.realpathSync(value);
	const stat = fs.statSync(resolved);
	if (stat.isDirectory()) {
		if (!fs.existsSync(path.join(resolved, "index.ts")) && !fs.existsSync(path.join(resolved, "index.js"))) {
			throw new Error(`Extension directory has no index.ts/index.js: ${resolved}`);
		}
	} else if (!stat.isFile() || !/\.[cm]?[jt]s$/.test(resolved)) throw new Error(`Not an extension file: ${resolved}`);
	return resolved;
}

/** Snapshot selected configs only. No connections, env interpolation, or credential commands run here.
 * Pi validates the selected records in the child before any model request. */
export function selectMcpServers(task: ResolvedTask, options: {
	agentDir: string; projectTrusted: boolean; registered?: RegisteredMcpServer[];
}): ChildConfig["mcpServers"] {
	if (!task.tools.mcp.length) return [];
	const records = new Map<string, ChildConfig["mcpServers"][number]>();
	for (const entry of options.registered ?? []) records.set(entry.name, {
		name: entry.name, config: structuredClone(entry.config) as unknown as Record<string, unknown>, source: entry.extensionPath,
	});
	const load = (file: string, project: boolean) => {
		if (!fs.existsSync(file)) return;
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		assertObject(raw, file);
		assertObject(raw.mcpServers, `${file}.mcpServers`);
		for (const name of task.tools.mcp) {
			if (!Object.hasOwn(raw.mcpServers, name)) continue;
			const config = raw.mcpServers[name];
			assertObject(config, `${file}.${name}`);
			if (project && Object.hasOwn(config, "auth")) throw new Error(`Project MCP cannot select provider credentials: ${name}`);
			const inherited = records.get(name);
			if (project && !("command" in config) && !("url" in config) && !("type" in config)) {
				assertKnownKeys(config, ["enabled", "exposure", "toolExposure"], `${file}.${name}`);
				if (!inherited) throw new Error(`MCP override has no user server: ${name}`);
				records.set(name, { name, config: { ...inherited.config, ...config }, source: file });
			} else records.set(name, { name, config: structuredClone(config), source: file });
		}
	};
	load(path.join(options.agentDir, "mcp.json"), false);
	if (options.projectTrusted) load(path.join(task.cwd, ".pi", "mcp.json"), true);
	const namespaces = new Set<string>();
	return [...new Set(task.tools.mcp)].map((name) => {
		const record = records.get(name);
		if (!record || record.config.enabled === false) throw new Error(`Unavailable or disabled MCP server: ${name}`);
		const namespace = name.replace(/-/g, "_");
		if (namespaces.has(namespace)) throw new Error(`Colliding MCP server names: ${name}`);
		namespaces.add(namespace);
		return record;
	});
}
