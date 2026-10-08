import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import extension from "../index.ts";
import companion from "../compat/plan-mode.ts";
import directoryCompanion from "../compat/plan-mode/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emptyUsage, type RunChild, type SingleResult } from "../contracts.ts";
async function fixture(t: TestContext, options: { hold?: boolean; plan?: boolean } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-extension-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
	const tools = new Map<string, any>(); const handlers = new Map<string, any[]>(); const events = new Map<string, any[]>(); const commands = new Map<string, any>();
	const entries: any[] = []; const notifications: any[] = []; const configs: any[] = []; let launched = 0; let active: string[] = [];
	const ctx: any = { cwd: root, model: { provider: "fake", id: "test" }, thinkingLevel: "high", mode: "json", hasUI: false,
		modelRegistry: { getAll: () => [{ provider: "fake", id: "test" }] }, sessionManager: { getEntries: () => entries, getBranch: () => entries }, isIdle: () => false, isProjectTrusted: () => false,
		ui: { setStatus: () => {}, notify: () => {} } };
	if (options.plan) entries.push({ type: "custom", customType: "plan-mode-state", data: { enabled: true } });
	const pi: any = { on: (name: string, handler: unknown) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; },
		registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer: () => {}, registerFlag: () => {}, getFlag: () => false,
		registerCommand: (name: string, definition: any) => commands.set(name, definition), getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), sendMessage: (message: any, options: any) => notifications.push({ message, options }), getMcpServers: () => [],
		events: { on: (name: string, handler: unknown) => { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); return () => {}; }, emit: (name: string, data: unknown) => { for (const handler of events.get(name) ?? []) handler(data); } } };
	const runner: RunChild = async (task, files, signal, update) => {
		launched++; configs.push(JSON.parse(await fs.readFile(files.configPath, "utf8")));
		const result: SingleResult = { agent: task.agent, agentSource: task.agentSource, task: task.task, exitCode: 0, messages: [], stderr: "", output: task.task,
			state: "completed", resolved: task, model: task.model, thinking: task.thinking, usage: { ...emptyUsage(), input: 10, output: 2, turns: 1, totalTokens: 12, cost: 0.1 }, usageComplete: true };
		update(result);
		if (options.hold) await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
		await fs.writeFile(files.outputPath, task.task); return signal.aborted ? { ...result, state: "cancelled", exitCode: 1 } : result;
	};
	extension(pi as ExtensionAPI, { runner });
	const emit = async (name: string, data: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(data, ctx); };
	await emit("session_start");
	t.after(async () => { await emit("session_shutdown"); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await fs.rm(root, { recursive: true, force: true }); });
	const call = (name: string, params: any, signal?: AbortSignal, onUpdate?: any) => tools.get(name).execute("call", params, signal, onUpdate, ctx);
	return { pi, ctx, root, entries, notifications, configs, commands, handlers, call, emit, launched: () => launched };
}
test("extension exposes arbitrary inline overrides, foreground output and its own ledger (no native charge)", async (t) => {
	const f = await fixture(t);
	const answer = await f.call("subagent", { task: "first", config: { thinking: "low", rolePrompt: { replace: "review", append: "extra" }, tools: { allow: ["read"] } } });
	assert.equal(answer.isError, false); assert.ok(answer.content[0].text.includes("first")); assert.equal(answer.usage, undefined);
	assert.equal(f.configs[0].task.rolePrompt, "review\n\nextra"); assert.equal(f.configs[0].task.thinking, "low");
	assert.equal(f.notifications.length, 0);
	const listed = await f.call("subagent_task", { action: "list" }); assert.equal(listed.details.usage.input, 10);
	assert.ok(f.entries.some((entry) => entry.customType === "subagent-usage-v1"));
});
test("single, parallel and chain background paths immediately return IDs, detach caller and wake with followUp exactly once", async (t) => {
	const f = await fixture(t, { hold: true }); const controller = new AbortController(); let toolUpdates = 0;
	const launched = await f.call("subagent", { task: "background", background: true, config: { tools: { allow: ["read"] } } }, controller.signal, () => { toolUpdates++; });
	const id = launched.details.taskId; assert.ok(id); controller.abort();
	while (!f.launched()) await delay(1);
	const status = await f.call("subagent_task", { action: "status", taskId: id }); assert.equal(status.details.state, "running");
	await f.call("subagent_task", { action: "cancel", taskId: id });
	assert.equal(toolUpdates, 0); assert.equal(f.notifications.length, 1);
	assert.deepEqual(f.notifications[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.ok(!f.notifications[0].message.content.includes("Task: background"));
});
test("background parallel and chain complete with notifications and result pagination", async (t) => {
	const f = await fixture(t);
	for (const items of [{ tasks: [{ task: "one" }, { task: "two" }] }, { chain: [{ task: "one" }, { task: "two {previous}" }] }]) {
		const started = await f.call("subagent", { ...items, background: true, config: { tools: { allow: ["read"] } } });
		const id = started.details.taskId;
		for (let i = 0; i < 100; i++) { if ((await f.call("subagent_task", { action: "status", taskId: id })).details.state === "completed") break; await delay(2); }
		const output = await f.call("subagent_task", { action: "result", taskId: id }); assert.equal(output.isError, undefined); assert.ok(output.content[0].text.includes("one"));
	}
	assert.equal(f.notifications.length, 2); assert.equal((await f.call("subagent_task", { action: "list" })).details.usage.input, 40);
});
test("Plan Mode rejects actual writable/default/external permissions regardless of role labels", async (t) => {
	const f = await fixture(t, { plan: true });
	const rejected = await f.call("subagent", { task: "write" }); assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /Plan Mode/); assert.equal(f.launched(), 0);
	const approved = await f.call("subagent", { task: "read", config: { tools: { allow: ["read", "grep"] } } }); assert.equal(approved.isError, false); assert.equal(f.launched(), 1);
});
test("reload/shutdown restores only the accounting baseline, not tasks or notifications", async (t) => {
	const f = await fixture(t); await f.call("subagent", { task: "old" });
	await f.emit("session_shutdown", { reason: "reload" }); await f.emit("session_start", { reason: "reload" });
	const listed = await f.call("subagent_task", { action: "list" }); assert.deepEqual(listed.details.tasks, []); assert.equal(listed.details.usage.input, 10);
	await f.call("subagent", { task: "new" }); assert.equal((await f.call("subagent_task", { action: "list" })).details.usage.input, 20); assert.equal(f.notifications.length, 0);
});
test("project roles and executable extensions cannot silently self-approve without UI", async (t) => {
	const f = await fixture(t); await fs.mkdir(path.join(f.root, ".pi", "agents"), { recursive: true });
	await fs.writeFile(path.join(f.root, ".pi", "agents", "local.md"), "---\nname: local\ndescription: local role\n---\nlocal prompt");
	const local = await f.call("subagent", { agent: "local", task: "x", agentScope: "project" }); assert.equal(local.isError, true); assert.match(local.content[0].text, /approval/);
	const source = path.join(f.root, "source.ts"); await fs.writeFile(source, "export default () => {};");
	const external = await f.call("subagent", { task: "x", config: { tools: { extensions: [source] } } }); assert.equal(external.isError, true); assert.match(external.content[0].text, /approval/);
	assert.equal(f.launched(), 0);
});
test("companion Plan Mode waits for writer cancellation, allows task management, and never uses role/type authorization", async (t) => {
	const f = await fixture(t, { hold: true }); companion(f.pi);
	const bg = await f.call("subagent", { task: "writer", background: true }); while (!f.launched()) await delay(1);
	await f.commands.get("plan").handler("on", f.ctx);
	const status = await f.call("subagent_task", { action: "status", taskId: bg.details.taskId }); assert.equal(status.details.state, "cancelled");
	assert.equal(f.notifications.length, 0);
	const rejected = await f.call("subagent", { task: "writer" }); assert.equal(rejected.isError, true);
});
test("installed directory companion preserves planning workflow and restores the original tool loadout", async (t) => {
	assert.equal(directoryCompanion, companion);
	const f = await fixture(t); f.pi.setActiveTools(["read", "bash", "custom"]);
	f.entries.push({ type: "custom", customType: "plan-mode-state", data: { enabled: true, toolsBeforePlanMode: ["read", "bash", "custom"] } });
	companion(f.pi); await f.emit("session_start");
	assert.ok(f.pi.getActiveTools().includes("subagent_task")); assert.ok(!f.pi.getActiveTools().includes("bash"));
	const prompt = await f.handlers.get("before_agent_start")!.at(-1)({ systemPrompt: "BASE" });
	assert.match(prompt.systemPrompt, /Understand the goal/); assert.match(prompt.systemPrompt, /Risks and open questions/);
	assert.match(prompt.systemPrompt, /resolved permissions, not role names/); assert.doesNotMatch(prompt.systemPrompt, /type "explore"/);
	await f.commands.get("plan").handler("off", f.ctx);
	assert.deepEqual(f.pi.getActiveTools(), ["read", "bash", "custom"]);
	const entries = f.entries.length; await f.commands.get("plan").handler("off", f.ctx); assert.equal(f.entries.length, entries);
});
