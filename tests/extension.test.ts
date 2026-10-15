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
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let i = 0; i < 1000; i++) { if (await predicate()) return; await delay(2); }
	assert.fail("Timed out waiting for fixture state");
}
async function fixture(t: TestContext, options: { hold?: boolean; plan?: boolean; idle?: boolean; tui?: boolean } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-extension-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
	const tools = new Map<string, any>(); const handlers = new Map<string, any[]>(); const events = new Map<string, any[]>(); const commands = new Map<string, any>();
	const entries: any[] = []; const notifications: any[] = []; const configs: any[] = []; const statuses = new Map<string, string>();
	const releases = new Map<string, (failed?: boolean) => void>(); let launched = 0; let active: string[] = [];
	const ctx: any = { cwd: root, model: { provider: "fake", id: "test" }, thinkingLevel: "high", mode: options.tui ? "tui" : "json", hasUI: options.tui ?? false,
		modelRegistry: { getAll: () => [{ provider: "fake", id: "test" }] }, sessionManager: { getEntries: () => entries, getBranch: () => entries }, isIdle: () => options.idle ?? false, isProjectTrusted: () => false,
		ui: { setStatus: (key: string, text: string) => statuses.set(key, text), notify: () => {} } };
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
		let failed = false;
		if (options.hold) await new Promise<void>((resolve) => {
			const finish = (failure = false) => { failed = failure; releases.delete(task.task); signal.removeEventListener("abort", abort); resolve(); };
			const abort = () => finish();
			releases.set(task.task, finish);
			if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
		});
		await fs.writeFile(files.outputPath, task.task);
		return signal.aborted ? { ...result, state: "cancelled", exitCode: 1 } : failed ? { ...result, state: "failed", exitCode: 1 } : result;
	};
	extension(pi as ExtensionAPI, { runner });
	const emit = async (name: string, data: any = {}) => {
		const event: any = { type: name, entries: [], continue: false, ...data };
		for (const handler of handlers.get(name) ?? []) {
			const result = await handler(event, ctx);
			if (result?.entries !== undefined) event.entries = result.entries;
			if (result?.continue !== undefined) event.continue = result.continue;
			if (result?.message !== undefined) event.message = result.message;
		}
		if (name === "agent_before_settle") for (const entry of event.entries) {
			entries.push(entry);
			if (entry.type === "custom_message" && entry.customType === "subagent-complete") notifications.push({ message: entry, options: { boundary: true } });
		}
		return event;
	};
	await emit("session_start");
	t.after(async () => { await emit("session_shutdown"); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await fs.rm(root, { recursive: true, force: true }); });
	let nextCall = 0;
	const call = async (name: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
		const id = `call-${++nextCall}`;
		const answer = await tools.get(name).execute(id, params, signal, onUpdate, ctx);
		const final = await emit("message_end", { message: { role: "toolResult", toolCallId: id, toolName: name,
			content: answer.content, details: answer.details, isError: answer.isError ?? false, timestamp: Date.now() } });
		entries.push({ type: "message", message: final.message });
		await emit("turn_end", { toolResults: [final.message] });
		return answer;
	};
	const complete = (task: string, failed = false) => { const release = releases.get(task); assert.ok(release, `No held child: ${task}`); release(failed); };
	return { pi, ctx, root, entries, notifications, configs, statuses, commands, handlers, call, emit, complete, held: () => releases.size, launched: () => launched };
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
test("TUI footer counts active child items, not delegation calls", async (t) => {
	const f = await fixture(t, { hold: true, tui: true });
	const started = await f.call("subagent", { tasks: [{ task: "one" }, { task: "two" }], background: true, config: { tools: { allow: ["read"] } } });
	assert.notEqual(started.isError, true);
	await waitFor(() => f.held() === 2);
	assert.equal(f.launched(), 2);
	const status = await f.call("subagent_task", { action: "status", taskId: started.details.taskId });
	assert.deepEqual(status.details.results.map((item: any) => item.state), ["running", "running"]);
	assert.match(f.statuses.get("subagent")!, /^subagents: 2 active · /);
	f.complete("one");
	await waitFor(() => /^subagents: 1 active · /.test(f.statuses.get("subagent")!));
	f.complete("two");
	await waitFor(async () => (await f.call("subagent_task", { action: "status", taskId: started.details.taskId })).details.state === "completed");
	assert.equal(f.statuses.get("subagent"), "subagents: 2 turns ↑20 ↓4 $0.2000");
	const listed = await f.call("subagent_task", { action: "list" });
	assert.equal(listed.details.tasks[0].state, "completed"); assert.equal(listed.details.usage.input, 20);
	assert.equal((await f.emit("agent_before_settle")).continue, true);
	assert.equal(f.notifications.length, 1);
});
test("TUI footer separates the global process-slot queue across delegation calls", async (t) => {
	const f = await fixture(t, { hold: true, tui: true });
	const config = { tools: { allow: ["read"] } };
	const first = await f.call("subagent", { tasks: Array.from({ length: 6 }, (_, i) => ({ task: `parallel-${i}` })), background: true, notify: false, config });
	const second = await f.call("subagent", { task: "single", background: true, notify: false, config });
	assert.notEqual(first.isError, true); assert.notEqual(second.isError, true);
	await waitFor(() => f.held() === 4);
	assert.equal(f.launched(), 4);
	assert.match(f.statuses.get("subagent")!, /^subagents: 4 active · 3 queued · /);
	f.complete("parallel-0");
	await waitFor(() => f.held() === 4 && /^subagents: 4 active · 2 queued · /.test(f.statuses.get("subagent")!));
	await f.call("subagent_task", { action: "cancel", taskId: first.details.taskId });
	await waitFor(() => f.held() === 1);
	assert.equal(f.launched(), 6);
	assert.match(f.statuses.get("subagent")!, /^subagents: 1 active · /);
	assert.doesNotMatch(f.statuses.get("subagent")!, /queued/);
	f.complete("single");
	await waitFor(async () => (await f.call("subagent_task", { action: "status", taskId: second.details.taskId })).details.state === "completed");
	assert.doesNotMatch(f.statuses.get("subagent")!, /active|queued/);
	assert.equal((await f.call("subagent_task", { action: "list" })).details.usage.input, 60);
});
test("TUI footer counts future chain steps as queued and excludes failed/skipped items", async (t) => {
	const f = await fixture(t, { hold: true, tui: true });
	const started = await f.call("subagent", { chain: [{ task: "first" }, { task: "second" }, { task: "never" }], background: true, config: { tools: { allow: ["read"] } } });
	assert.notEqual(started.isError, true);
	await waitFor(() => f.held() === 1);
	assert.match(f.statuses.get("subagent")!, /^subagents: 1 active · 2 queued · /);
	f.complete("first");
	await waitFor(() => f.held() === 1 && /^subagents: 1 active · 1 queued · /.test(f.statuses.get("subagent")!));
	f.complete("second", true);
	await waitFor(() => !/active|queued/.test(f.statuses.get("subagent")!));
	const status = await f.call("subagent_task", { action: "status", taskId: started.details.taskId });
	assert.deepEqual(status.details.results.map((item: any) => item.state), ["completed", "failed", "skipped"]);
	assert.equal(f.launched(), 2); assert.equal(status.details.usage.input, 20);
	assert.equal((await f.emit("agent_before_settle")).continue, true);
});
test("TUI footer counts foreground children and retains the empty-session fallback", async (t) => {
	const f = await fixture(t, { hold: true, tui: true });
	await f.call("subagent_task", { action: "list" });
	assert.equal(f.statuses.get("subagent"), "subagents: 0 turns");
	const answer = f.call("subagent", { tasks: [{ task: "one" }, { task: "two" }], config: { tools: { allow: ["read"] } } });
	await waitFor(() => f.held() === 2);
	assert.match(f.statuses.get("subagent")!, /^subagents: 2 active · /);
	f.complete("one"); f.complete("two");
	assert.equal((await answer).isError, false);
	assert.equal(f.statuses.get("subagent"), "subagents: 2 turns ↑20 ↓4 $0.2000");
	assert.equal(f.notifications.length, 0);
});
test("background paths return IDs, detach caller and notify once at parent settlement", async (t) => {
	const f = await fixture(t, { hold: true }); const controller = new AbortController(); let toolUpdates = 0;
	const launched = await f.call("subagent", { task: "background", background: true, config: { tools: { allow: ["read"] } } }, controller.signal, () => { toolUpdates++; });
	const id = launched.details.taskId; assert.ok(id); controller.abort();
	while (!f.launched()) await delay(1);
	const status = await f.call("subagent_task", { action: "status", taskId: id }); assert.equal(status.details.state, "running");
	await f.call("subagent_task", { action: "cancel", taskId: id });
	assert.equal(toolUpdates, 0); assert.equal(f.notifications.length, 0);
	assert.equal((await f.emit("agent_before_settle")).continue, true);
	assert.equal(f.notifications.length, 1);
	await f.emit("agent_before_settle"); assert.equal(f.notifications.length, 1);
	assert.ok(!f.notifications[0].message.content.includes("Task: background"));
});
for (const background of [false, true]) test(`${background ? "background" : "foreground"} timeout exposes structured status and cancel diagnostics`, async (t) => {
	const f = await fixture(t, { hold: true });
	const answer = await f.call("subagent", { task: "bounded", background, config: { timeoutMs: 100, tools: { allow: ["read"] } } });
	const taskId = answer.details.taskId;
	if (!background) {
		assert.equal(answer.isError, true);
		assert.equal(answer.details.results[0].timedOut, true);
		assert.match(answer.content[0].text, /timed out after 100 ms/);
	}
	await waitFor(async () => (await f.call("subagent_task", { action: "status", taskId })).details.state === "failed");
	for (const action of ["status", "cancel"]) {
		const response = await f.call("subagent_task", { action, taskId });
		for (const data of [response.details, JSON.parse(response.content[0].text)]) {
			assert.equal(data.state, "failed");
			assert.equal(data.results[0].timedOut, true);
			assert.equal(data.results[0].timeoutMs, 100);
			assert.equal(data.results[0].exitCode, 1);
			assert.match(data.results[0].errorMessage, /timed out after 100 ms/);
			assert.equal(data.usage.input, 10);
		}
	}
	assert.equal(f.configs[0].task.timeoutMs, 100);
	await f.emit("agent_before_settle"); await f.emit("agent_before_settle");
	assert.equal(f.notifications.length, background ? 1 : 0);
});
test("complete parallel and chain results consume pending reminders without changing usage", async (t) => {
	const f = await fixture(t);
	for (const items of [{ tasks: [{ task: "one" }, { task: "two" }] }, { chain: [{ task: "one" }, { task: "two {previous}" }] }]) {
		const started = await f.call("subagent", { ...items, background: true, config: { tools: { allow: ["read"] } } });
		const id = started.details.taskId;
		for (let i = 0; i < 100; i++) { if ((await f.call("subagent_task", { action: "status", taskId: id })).details.state === "completed") break; await delay(2); }
		const output = await f.call("subagent_task", { action: "result", taskId: id }); assert.equal(output.isError, undefined); assert.ok(output.content[0].text.includes("one"));
	}
	await f.emit("agent_before_settle");
	assert.equal(f.notifications.length, 0);
	const listed = await f.call("subagent_task", { action: "list" });
	assert.ok(listed.details.tasks.every((job: any) => job.resultDelivered));
	assert.equal(listed.details.usage.input, 40);
});
test("settlement batches only uncollected results and preserves other extensions' drafts", async (t) => {
	const f = await fixture(t);
	const ids: string[] = [];
	for (const task of ["PRIVATE FIRST REPORT", "PRIVATE SECOND REPORT", "PRIVATE THIRD REPORT"]) {
		const started = await f.call("subagent", { task, background: true, config: { tools: { allow: ["read"] } } });
		ids.push(started.details.taskId);
		for (let i = 0; i < 100; i++) { if ((await f.call("subagent_task", { action: "status", taskId: ids.at(-1) })).details.state === "completed") break; await delay(2); }
	}
	await f.call("subagent_task", { action: "result", taskId: ids[0] });
	f.handlers.get("agent_before_settle")!.unshift((event: any) => ({ entries: [...event.entries, { type: "custom", customType: "other-extension", data: { kept: true } }] }));
	const boundary = await f.emit("agent_before_settle");
	assert.equal(boundary.continue, true); assert.equal(f.notifications.length, 1);
	assert.ok(f.entries.some((entry) => entry.customType === "other-extension"));
	assert.deepEqual(f.notifications[0].message.details.tasks.map((job: any) => job.taskId), ids.slice(1));
	assert.doesNotMatch(f.notifications[0].message.content, /PRIVATE/);
	await f.emit("agent_before_settle"); assert.equal(f.notifications.length, 1);
	assert.equal((await f.call("subagent_task", { action: "list" })).details.usage.input, 30);
});
test("partial/log/error reads keep reminders; complete finalized output consumes them", async (t) => {
	const f = await fixture(t);
	const started = await f.call("subagent", { task: "分页🌍 report", background: true, config: { tools: { allow: ["read"] } } });
	const taskId = started.details.taskId;
	for (let i = 0; i < 100; i++) { if ((await f.call("subagent_task", { action: "status", taskId })).details.state === "completed") break; await delay(2); }
	await f.call("subagent_task", { action: "result", taskId, maxBytes: 3 });
	await f.call("subagent_task", { action: "result", taskId, view: "log" });
	assert.equal((await f.call("subagent_task", { action: "result", taskId, cursor: -1 })).isError, true);
	const controller = new AbortController(); controller.abort();
	assert.equal((await f.call("subagent_task", { action: "result", taskId }, controller.signal)).isError, true);
	assert.equal((await f.call("subagent_task", { action: "status", taskId })).details.resultDelivered, false);
	await f.call("subagent_task", { action: "result", taskId });
	assert.equal((await f.call("subagent_task", { action: "status", taskId })).details.resultDelivered, true);
	assert.equal((await f.emit("agent_before_settle")).continue, false);
	assert.equal(f.notifications.length, 0);
});
test("later message_end redaction cannot falsely consume a completion reminder", async (t) => {
	const f = await fixture(t);
	const started = await f.call("subagent", { task: "private report", background: true, config: { tools: { allow: ["read"] } } });
	const taskId = started.details.taskId;
	for (let i = 0; i < 100; i++) { if ((await f.call("subagent_task", { action: "status", taskId })).details.state === "completed") break; await delay(2); }
	f.pi.on("message_end", (event: any) => event.message.toolName === "subagent_task" && event.message.details?.view === "output"
		? { message: { ...event.message, content: [{ type: "text", text: "redacted" }] } } : undefined);
	await f.call("subagent_task", { action: "result", taskId });
	assert.equal((await f.call("subagent_task", { action: "status", taskId })).details.resultDelivered, false);
	assert.equal((await f.emit("agent_before_settle")).continue, true);
	assert.equal(f.notifications.length, 1);
});
for (const idle of [true, false]) test(`completion wakes ${idle ? "directly while idle" : "after a busy-only operation becomes idle"}`, async (t) => {
	const f = await fixture(t, { idle });
	await f.call("subagent", { task: "ready", background: true, config: { tools: { allow: ["read"] } } });
	if (!idle) { await delay(20); assert.equal(f.notifications.length, 0); f.ctx.isIdle = () => true; }
	for (let i = 0; i < 100 && !f.notifications.length; i++) await delay(5);
	assert.equal(f.notifications.length, 1);
	assert.deepEqual(f.notifications[0].options, { triggerTurn: true, deliverAs: "followUp" });
});
for (const transition of ["tree", "reload"]) test(`${transition} drops completed pending reminders without losing the usage ledger`, async (t) => {
	const f = await fixture(t);
	const started = await f.call("subagent", { task: "old branch", background: true, config: { tools: { allow: ["read"] } } });
	const taskId = started.details.taskId;
	for (let i = 0; i < 100; i++) { if ((await f.call("subagent_task", { action: "status", taskId })).details.state === "completed") break; await delay(2); }
	if (transition === "tree") await f.emit("session_before_tree");
	else { await f.emit("session_shutdown", { reason: "reload" }); await f.emit("session_start", { reason: "reload" }); }
	await f.emit("agent_before_settle");
	assert.equal(f.notifications.length, 0);
	const listed = await f.call("subagent_task", { action: "list" });
	assert.equal(listed.details.usage.input, 10);
	if (transition === "tree") assert.equal(listed.details.tasks[0].state, "completed");
	else assert.deepEqual(listed.details.tasks, []);
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
