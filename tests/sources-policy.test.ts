import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { canonicalExtension, readUserConfig, selectMcpServers } from "../sources.ts";
import { resolveRun } from "../config.ts";
import { discoverAgents } from "../agents.ts";
import { enforcePlanMode, isPlanMode } from "../policy.ts";
import type { ResolvedTask } from "../contracts.ts";
function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sources-"));
	const agentDir = path.join(root, "agent"); const cwd = path.join(root, "repo");
	fs.mkdirSync(agentDir); fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	t.after(() => fs.rmSync(root, { force: true, recursive: true }));
	const task: ResolvedTask = { agent: "inline", agentSource: "inline", shadowedFiles: [], task: "x", cwd, model: "fake/test", thinking: "off", rolePrompt: "", tools: { allow: ["read"], extensions: [], mcp: [] }, readOnly: true, provenance: {} };
	return { root, agentDir, cwd, task, write: (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value)) };
}
test("only explicit extension files/directories/built-ins load, and defaults have source-relative paths", (t) => {
	const f = fixture(t); const file = path.join(f.agentDir, "tool.ts"); fs.writeFileSync(file, "export default () => {};");
	f.write(path.join(f.agentDir, "subagent.json"), { defaults: { tools: { extensions: ["tool.ts", "builtin:codemode"] } }, trustedExtensions: ["tool.ts"] });
	const user = readUserConfig(f.agentDir); assert.deepEqual(user.trustedExtensions, [fs.realpathSync(file)]);
	assert.deepEqual(user.defaults?.tools?.extensions, [file, "builtin:codemode"]);
	assert.equal(canonicalExtension("builtin:tool-search"), "builtin:tool-search");
	assert.throws(() => canonicalExtension("builtin:mcp"), /Unsupported/);
	assert.throws(() => canonicalExtension(f.cwd), /index/);
	const run = resolveRun({ task: "x", config: { tools: { extensions: ["builtin:codemode"] } } }, { cwd: f.cwd, agents: [], parentModel: "fake/test" });
	assert.deepEqual(run.tasks[0].tools.extensions, ["builtin:codemode"]); assert.equal(run.tasks[0].readOnly, false);
});
test("canonical models introduced by explicit child sources defer to child catalog validation, never fuzzy lookup", (t) => {
	const f = fixture(t);
	const environment = { cwd: f.cwd, agents: [], parentModel: "fake/test", availableModels: ["fake/test"] };
	const run = resolveRun({ task: "x", config: { model: "new-provider/model", tools: { extensions: ["provider.ts"] } } }, environment);
	assert.equal(run.tasks[0].model, "new-provider/model");
	assert.equal(run.tasks[0].provenance["model.validation"], "child-source");
	assert.throws(() => resolveRun({ task: "x", config: { model: "new-provider/model" } }, environment), /unavailable model/);
	assert.throws(() => resolveRun({ task: "x", config: { model: "model", tools: { extensions: ["provider.ts"] } } }, environment), /unavailable model/);
});

test("user config is strict, absent is safe, invalid config never widens defaults", (t) => {
	const f = fixture(t); assert.deepEqual(readUserConfig(f.agentDir), { trustedExtensions: [] });
	for (const raw of [{ defaults: { tools: { alow: [] } } }, { typo: true }, { trustedExtensions: "all" }]) {
		f.write(path.join(f.agentDir, "subagent.json"), raw); assert.throws(() => readUserConfig(f.agentDir));
	}
});
test("user timeout defaults reach resolution and invalid limits fail closed", (t) => {
	const f = fixture(t);
	const file = path.join(f.agentDir, "subagent.json");
	for (const timeoutMs of [0, 120000]) {
		f.write(file, { defaults: { timeoutMs } });
		const defaults = readUserConfig(f.agentDir).defaults;
		assert.equal(resolveRun({ task: "x" }, { cwd: f.cwd, agents: [], parentModel: "fake/test", defaults }).tasks[0].timeoutMs, timeoutMs);
	}
	for (const timeoutMs of [-1, 1.5, 2147483648, "1000", null]) {
		f.write(file, { defaults: { timeoutMs } });
		assert.throws(() => readUserConfig(f.agentDir), /timeoutMs.*integer/);
	}
});
test("MCP snapshots load only explicitly selected names; do not evaluate credential commands", (t) => {
	const f = fixture(t); const marker = path.join(f.root, "must-not-exist");
	f.write(path.join(f.agentDir, "mcp.json"), { mcpServers: { docs: { url: "https://invalid.example/mcp", headers: { Authorization: `!touch ${marker}` } }, other: { command: "must-not-run" } } });
	const selected = selectMcpServers({ ...f.task, tools: { ...f.task.tools, mcp: ["docs"] } }, { agentDir: f.agentDir, projectTrusted: false });
	assert.equal(selected.length, 1); assert.equal(selected[0].name, "docs"); assert.ok(!fs.existsSync(marker));
	assert.deepEqual(selectMcpServers(f.task, { agentDir: f.agentDir, projectTrusted: true }), []);
	assert.throws(() => selectMcpServers({ ...f.task, tools: { ...f.task.tools, mcp: ["missing"] } }, { agentDir: f.agentDir, projectTrusted: false }), /Unavailable/);
});
test("project MCP overrides require trust, disabled servers error and provider credential routing is forbidden", (t) => {
	const f = fixture(t); const input = { ...f.task, tools: { ...f.task.tools, mcp: ["docs"] } };
	f.write(path.join(f.agentDir, "mcp.json"), { mcpServers: { docs: { url: "https://user.invalid/mcp", headers: { Token: "keep" } } } });
	const project = path.join(f.cwd, ".pi", "mcp.json"); f.write(project, { mcpServers: { docs: { enabled: false } } });
	assert.equal(selectMcpServers(input, { agentDir: f.agentDir, projectTrusted: false })[0].config.url, "https://user.invalid/mcp");
	assert.throws(() => selectMcpServers(input, { agentDir: f.agentDir, projectTrusted: true }), /disabled/);
	f.write(project, { mcpServers: { docs: { exposure: "direct" } } });
	assert.deepEqual(selectMcpServers(input, { agentDir: f.agentDir, projectTrusted: true })[0].config.headers, { Token: "keep" });
	f.write(project, { mcpServers: { docs: { url: "https://other.invalid/mcp", auth: { provider: "openai" } } } });
	assert.throws(() => selectMcpServers(input, { agentDir: f.agentDir, projectTrusted: true }), /credentials/);
});
test("registered MCP servers may be explicitly selected; namespace collisions fail", (t) => {
	const f = fixture(t); const registered = [{ name: "docs", config: { command: "test" }, extensionPath: "/trusted.ts" }];
	assert.equal(selectMcpServers({ ...f.task, tools: { ...f.task.tools, mcp: ["docs"] } }, { agentDir: f.agentDir, projectTrusted: false, registered })[0].source, "/trusted.ts");
	f.write(path.join(f.agentDir, "mcp.json"), { mcpServers: { "a-b": { command: "test" }, a_b: { command: "test" } } });
	assert.throws(() => selectMcpServers({ ...f.task, tools: { ...f.task.tools, mcp: ["a-b", "a_b"] } }, { agentDir: f.agentDir, projectTrusted: false }), /Colliding/);
});
test("bundled roles inherit the model and reviewed roles clear inherited external sources", () => {
	const discovery = discoverAgents(process.cwd(), "user", path.resolve("agents"));
	assert.deepEqual(discovery.diagnostics, []); assert.equal(discovery.agents.length, 4);
	for (const agent of ["scout", "planner", "reviewer"]) {
		const run = resolveRun({ agent, task: "x" }, { cwd: process.cwd(), agents: discovery.agents, parentModel: "fake/test", defaults: { tools: { extensions: ["global.ts"], mcp: ["global"] } } });
		assert.equal(run.tasks[0].readOnly, true); assert.equal(run.tasks[0].model, "fake/test");
	}
});

test("Plan Mode follows actual resolved permissions, not role labels, and explicit persisted off overrides startup flag", () => {
	const ctx = (enabled?: boolean) => ({ sessionManager: { getBranch: () => enabled === undefined ? [] : [{ type: "custom", customType: "plan-mode-state", data: { enabled } }] } }) as Parameters<typeof isPlanMode>[0];
	assert.equal(isPlanMode(ctx(), true), true); assert.equal(isPlanMode(ctx(false), true), false); assert.equal(isPlanMode(ctx(true)), true);
	const environment = { cwd: process.cwd(), agents: [], parentModel: "fake/test" };
	const readonly = resolveRun({ task: "x", config: { tools: { allow: ["read", "grep"] } } }, environment); enforcePlanMode(readonly);
	const writable = resolveRun({ task: "x" }, environment); writable.tasks[0].agent = "explore"; assert.throws(() => enforcePlanMode(writable), /Plan Mode/);
	const external = resolveRun({ task: "x", config: { tools: { allow: ["read"], mcp: ["docs"] } } }, environment); assert.throws(() => enforcePlanMode(external));
});
