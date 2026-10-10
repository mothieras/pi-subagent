import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { emptyUsage, type ResolvedRun, type SingleResult } from "../contracts.ts";
import { SessionTasks } from "../tasks.ts";

async function fixture(t: TestContext, state: "completed" | "failed" | "cancelled" = "completed", maxRetainedJobs?: number) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-delivery-test-"));
	const task = { agent: "inline", agentSource: "inline" as const, shadowedFiles: [], task: "你好🌍 result", cwd: root,
		model: "fake/test", thinking: "off" as const, rolePrompt: "", tools: { allow: ["read"], extensions: [], mcp: [] }, readOnly: true, provenance: {} };
	const run: ResolvedRun = { mode: "single", agentScope: "user", projectAgentsDir: null, tasks: [task], background: true, notify: true, allowSharedWrites: false };
	let entered!: () => void;
	const running = new Promise<void>((resolve) => { entered = resolve; });
	const manager = new SessionTasks({ tmpRoot: root, maxRetainedJobs, workspace: async (cwd) => cwd, runner: async (input, files, signal) => {
		entered();
		if (state === "cancelled") await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
		await fs.writeFile(files.outputPath, input.task); await fs.writeFile(files.logPath, "running log");
		const result: SingleResult = { agent: input.agent, agentSource: input.agentSource, task: input.task, messages: [], stderr: "", output: input.task,
			state, exitCode: state === "completed" ? 0 : 1, usage: { ...emptyUsage(), input: 10, turns: 1 }, usageComplete: true };
		return result;
	} });
	t.after(async () => { await manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
	const started = await manager.start(run);
	if (state === "cancelled") { await running; await manager.cancel(started.taskId); }
	await started.done;
	return { manager, id: started.taskId, run };
}
async function deliver(manager: SessionTasks, id: string, callId: string, options: { cursor?: number; maxBytes?: number; view?: "output" | "log" } = {}, change: { isError?: boolean; text?: string; toolName?: string } = {}) {
	const page = await manager.read(id, options);
	const text = page.text + (page.nextCursor === null ? "" : `\n[Continue with cursor: ${page.nextCursor}]`);
	manager.trackDelivery(callId, id, page, text);
	manager.observeDelivery({ role: "toolResult", toolCallId: callId, toolName: change.toolName ?? "subagent_task", isError: change.isError ?? false,
		content: [{ type: "text", text: change.text ?? text }], timestamp: Date.now() });
	return page;
}
test("an output read started while running cannot deliver bytes captured before completion", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-read-race-test-"));
	let entered!: () => void; let finish!: () => void; let captured!: () => void; let releaseRead!: () => void;
	const running = new Promise<void>((resolve) => { entered = resolve; });
	const finishing = new Promise<void>((resolve) => { finish = resolve; });
	const readCaptured = new Promise<void>((resolve) => { captured = resolve; });
	const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
	let outputPath = ""; let intercepted = false;
	const source = { agent: "inline", agentSource: "inline" as const, shadowedFiles: [], task: "work", cwd: root, model: "fake/test", thinking: "off" as const,
		rolePrompt: "", tools: { allow: ["read"], extensions: [], mcp: [] }, readOnly: true, provenance: {} };
	const manager = new SessionTasks({ tmpRoot: root, workspace: async (cwd) => cwd, runner: async (input, files, _signal, update) => {
		outputPath = files.outputPath; await fs.writeFile(outputPath, "partial");
		const result: SingleResult = { agent: input.agent, agentSource: input.agentSource, task: input.task, messages: [], stderr: "", exitCode: 0, usage: emptyUsage(), output: "partial" };
		update(result); entered(); await finishing;
		await fs.writeFile(outputPath, "partial + final tail"); return { ...result, state: "completed", output: "partial + final tail" };
	} });
	t.after(async () => { finish(); releaseRead(); await manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
	const started = await manager.start({ mode: "single", agentScope: "user", projectAgentsDir: null, tasks: [source], background: true, notify: true, allowSharedWrites: false });
	await running;
	const mutableFs = createRequire(import.meta.url)("node:fs/promises") as typeof fs;
	const readFile = mutableFs.readFile;
	t.mock.method(mutableFs, "readFile", async (file: any, options: any) => {
		const data = await readFile(file, options);
		if (String(file) === outputPath && !intercepted) { intercepted = true; captured(); await readGate; }
		return data;
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const reading = manager.read(started.taskId).then((page) => ({ page, error: undefined }), (error: Error) => ({ page: undefined, error }));
	const first = await Promise.race([reading, readCaptured.then(() => undefined)]);
	finish(); await started.done; releaseRead();
	const answer = first ?? await reading;
	if (answer.page) {
		manager.trackDelivery("racing-page", started.taskId, answer.page, answer.page.text);
		manager.observeDelivery({ role: "toolResult", toolCallId: "racing-page", toolName: "subagent_task", isError: false, content: [{ type: "text", text: answer.page.text }], timestamp: Date.now() });
	}
	assert.equal(manager.status(started.taskId).resultDelivered, false, "pre-completion bytes cannot consume a final reminder");
	assert.match(answer.error?.message ?? "", /not finished/);
	assert.ok((await manager.read(started.taskId)).text.includes("final tail"));
});
test("eviction-in-progress cannot deliver a heading-only result after its output file disappears", async (t) => {
	const { manager, id, run } = await fixture(t, "completed", 1);
	let deleting!: () => void; let releaseDelete!: () => void;
	const deletionStarted = new Promise<void>((resolve) => { deleting = resolve; });
	const deletionGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
	const mutableFs = createRequire(import.meta.url)("node:fs/promises") as typeof fs;
	const rm = mutableFs.rm;
	let intercepted = false;
	t.mock.method(mutableFs, "rm", async (file: any, options: any) => {
		if (String(file).endsWith(id) && options?.recursive && !intercepted) {
			intercepted = true; await rm(path.join(String(file), "1", "output.txt"), { force: true }); deleting(); await deletionGate;
		}
		return rm(file, options);
	});
	syncBuiltinESMExports();
	t.after(() => { releaseDelete(); t.mock.restoreAll(); syncBuiltinESMExports(); });
	const next = await manager.start(run);
	await deletionStarted;
	const reading = manager.read(id).then((page) => ({ page, error: undefined }), (error: Error) => ({ page: undefined, error }));
	const answer = await reading;
	if (answer.page) {
		manager.trackDelivery("evicted-page", id, answer.page, answer.page.text);
		manager.observeDelivery({ role: "toolResult", toolCallId: "evicted-page", toolName: "subagent_task", isError: false, content: [{ type: "text", text: answer.page.text }], timestamp: Date.now() });
	}
	releaseDelete(); await next.done;
	assert.equal(manager.status(id).resultDelivered, false, "missing data cannot consume an expired outcome reminder");
	assert.match(answer.error?.message ?? "", /expired/);
	assert.equal(manager.pendingNotifications().find((notice) => notice.taskId === id)?.expired, true);
});
test("reading is a pure snapshot; only a successful finalized complete output consumes a reminder", async (t) => {
	const { manager, id } = await fixture(t);
	await manager.read(id); manager.status(id); manager.list();
	assert.equal(manager.status(id).resultDelivered, false);
	assert.equal(manager.pendingNotifications().length, 1);
	await deliver(manager, id, "complete");
	assert.equal(manager.status(id).resultDelivered, true);
	assert.equal(manager.list()[0].resultDelivered, true);
	assert.equal(manager.pendingNotifications().length, 0);
	assert.equal(manager.status(id).state, "completed");
	assert.ok((await manager.read(id)).text.includes("你好🌍 result"));
	assert.equal(manager.usage().input, 10);
});
test("output delivery covers every byte, including gaps, overlaps and out-of-order UTF-8 pages", async (t) => {
	const { manager, id } = await fixture(t);
	const first = await deliver(manager, id, "first", { maxBytes: 3 });
	const middle = await manager.read(id, { cursor: first.nextCursor!, maxBytes: 3 });
	await deliver(manager, id, "tail", { cursor: middle.nextCursor! });
	assert.equal(manager.status(id).resultDelivered, false, "a final page cannot consume a gap");
	await deliver(manager, id, "first-again", { maxBytes: 3 });
	assert.equal(manager.status(id).resultDelivered, false);
	await deliver(manager, id, "middle", { cursor: first.nextCursor!, maxBytes: 3 });
	assert.equal(manager.status(id).resultDelivered, true);
	assert.equal(manager.usage().input, 10);
});
test("tiny UTF-8 pages deliver a complete retained snapshot without splitting characters", async (t) => {
	const { manager, id } = await fixture(t);
	const full = await manager.read(id); let cursor = 0; let text = ""; let call = 0;
	while (true) {
		const page = await deliver(manager, id, `tiny-${++call}`, { cursor, maxBytes: 1 });
		text += page.text;
		assert.equal(manager.status(id).resultDelivered, page.nextCursor === null);
		if (page.nextCursor === null) break;
		cursor = page.nextCursor;
	}
	assert.equal(text, full.text); assert.ok(!text.includes("\ufffd"));
});
test("empty tail pages and concurrent overlapping receipts cannot invent or reverse complete delivery", async (t) => {
	const { manager, id } = await fixture(t);
	const full = await manager.read(id);
	await deliver(manager, id, "empty-tail", { cursor: full.totalBytes });
	assert.equal(manager.status(id).resultDelivered, false);
	const head = await manager.read(id, { maxBytes: 3 });
	manager.trackDelivery("full", id, full, full.text);
	manager.trackDelivery("head", id, head, `${head.text}\n[Continue with cursor: ${head.nextCursor}]`);
	for (const [callId, text] of [["full", full.text], ["head", `${head.text}\n[Continue with cursor: ${head.nextCursor}]`]]) {
		manager.observeDelivery({ role: "toolResult", toolCallId: callId, toolName: "subagent_task", isError: false, content: [{ type: "text", text }], timestamp: Date.now() });
		assert.equal(manager.status(id).resultDelivered, true);
	}
});
test("log, error, redacted and mismatched tool results do not consume output reminders", async (t) => {
	const { manager, id } = await fixture(t);
	await deliver(manager, id, "log", { view: "log" });
	await deliver(manager, id, "error", {}, { isError: true });
	await deliver(manager, id, "redacted", {}, { text: "removed by another extension" });
	await deliver(manager, id, "wrong-tool", {}, { toolName: "other" });
	assert.equal(manager.status(id).resultDelivered, false);
	assert.equal(manager.pendingNotifications().length, 1);
	await deliver(manager, id, "valid");
	assert.equal(manager.status(id).resultDelivered, true);
});
test("delivery is recorded for failed/cancelled outcomes without changing execution state", async (t) => {
	for (const state of ["failed", "cancelled"] as const) {
		const { manager, id } = await fixture(t, state);
		assert.equal(manager.pendingNotifications().length, 1);
		await deliver(manager, id, `read-${state}`);
		assert.equal(manager.status(id).resultDelivered, true);
		assert.equal(manager.status(id).state, state);
		assert.equal(manager.pendingNotifications().length, 0);
		assert.equal(manager.usage().input, 10);
	}
});
test("notification batches consume only dispatch eligibility, not results or usage", async (t) => {
	const { manager, id, run } = await fixture(t);
	const second = await manager.start(run); await second.done;
	assert.deepEqual(manager.takeNotifications().map((notice) => notice.taskId), [id, second.taskId]);
	assert.deepEqual(manager.takeNotifications(), []);
	assert.equal(manager.status(id).resultDelivered, false);
	assert.ok((await manager.read(id)).text.includes("result"));
	assert.equal(manager.usage().input, 20);
});
test("retention expiration preserves unhandled outcome reminders and usage without inventing delivery", async (t) => {
	const { manager, id } = await fixture(t, "completed", 0);
	assert.equal(manager.status(id).expired, true);
	assert.equal(manager.status(id).resultDelivered, false);
	assert.equal(manager.pendingNotifications()[0].expired, true);
	await assert.rejects(manager.read(id), /expired/);
	assert.equal(manager.takeNotifications()[0].taskId, id);
	assert.equal(manager.usage().input, 10);
});
test("branch cleanup suppresses completed pending reminders and invalidates in-flight delivery receipts", async (t) => {
	const { manager, id } = await fixture(t);
	const page = await manager.read(id);
	manager.trackDelivery("old-branch", id, page, page.text);
	await manager.cancelAll(true);
	manager.observeDelivery({ role: "toolResult", toolCallId: "old-branch", toolName: "subagent_task", isError: false,
		content: [{ type: "text", text: page.text }], timestamp: Date.now() });
	assert.deepEqual(manager.pendingNotifications(), []);
	assert.equal(manager.status(id).resultDelivered, false);
	assert.equal(manager.status(id).state, "completed");
	assert.equal(manager.usage().input, 10);
});
