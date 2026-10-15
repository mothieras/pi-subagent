import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { emptyUsage, type ResolvedRun, type ResolvedTask, type RunChild, type SingleResult } from "../contracts.ts";
import { SessionTasks } from "../tasks.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
const task = (overrides: Partial<ResolvedTask> = {}): ResolvedTask => ({ agent: "inline", agentSource: "inline", shadowedFiles: [], task: "bounded", cwd: process.cwd(), model: "fake/test", thinking: "off", rolePrompt: "", tools: { allow: ["read"], extensions: [], mcp: [] }, readOnly: true, provenance: {}, timeoutMs: 100, ...overrides });
const run = (overrides: Partial<ResolvedRun> = {}): ResolvedRun => ({ mode: "single", agentScope: "user", projectAgentsDir: null, tasks: [task()], background: false, notify: true, allowSharedWrites: false, ...overrides });
const result = (input: ResolvedTask): SingleResult => ({ agent: input.agent, agentSource: input.agentSource, task: input.task, exitCode: 0, state: "completed", messages: [], stderr: "", output: "partial evidence", usage: { ...emptyUsage(), input: 10, totalTokens: 10 }, usageComplete: false, resolved: input });
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
	if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
});
async function fixture(t: TestContext, runner: RunChild, options: Partial<ConstructorParameters<typeof SessionTasks>[0]> = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-timeout-"));
	const manager = new SessionTasks({ runner, tmpRoot: root, workspace: async (cwd) => cwd, ...options });
	t.after(async () => { await manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
	return { manager, root };
}

for (const background of [false, true]) test(`${background ? "background" : "foreground"} timeout preserves output and usage and notifies at most once`, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const ready = deferred(); let notifications = 0;
	const { manager, root } = await fixture(t, async (input, files, signal, update) => {
		await fs.writeFile(files.outputPath, "partial evidence");
		update(result(input)); ready.resolve();
		await aborted(signal);
		update(result(input));
		return { ...result(input), state: "cancelled", exitCode: 1 };
	}, { onComplete: () => { notifications++; } });
	const started = await manager.start(run({ background }));
	await ready.promise;
	t.mock.timers.tick(99);
	assert.equal(manager.status(started.taskId).results[0].state, "running");
	t.mock.timers.tick(1);
	const final = await started.done;
	assert.equal(final.state, "failed");
	assert.equal(final.results[0].state, "failed");
	assert.equal(final.results[0].timedOut, true);
	assert.equal(final.results[0].exitCode, 1);
	assert.match(final.results[0].errorMessage!, /timed out after 100 ms/);
	assert.equal(final.results[0].output, "partial evidence");
	assert.equal(final.results[0].usageComplete, false);
	assert.equal(manager.usage().input, 10);
	assert.match((await manager.read(started.taskId)).text, /partial evidence[\s\S]*timed out/);
	for (let i = 0; i < 3; i++) { manager.status(started.taskId); manager.list(); }
	assert.equal(manager.usage().input, 10);
	assert.equal(notifications, background ? 1 : 0);
	assert.equal(manager.takeNotifications().length, background ? 1 : 0);
	assert.deepEqual(manager.takeNotifications(), []);
	await assert.rejects(fs.access(path.join(root, (await fs.readdir(root))[0], started.taskId, "1", "config.json")), /ENOENT/);
});

test("queue time is excluded and a timed-out parallel child does not abort its sibling", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const firstReady = deferred(); const secondReady = deferred(); const releaseFirst = deferred(); let secondSignal!: AbortSignal;
	t.after(() => releaseFirst.resolve());
	const { manager } = await fixture(t, async (input, _files, signal) => {
		if (input.task === "first") { firstReady.resolve(); await Promise.race([releaseFirst.promise, aborted(signal)]); }
		else { secondSignal = signal; secondReady.resolve(); await aborted(signal); }
		return result(input);
	}, { concurrency: 1 });
	const started = await manager.start(run({ mode: "parallel", tasks: [task({ task: "first", timeoutMs: 0 }), task({ task: "second" })] }));
	await firstReady.promise;
	t.mock.timers.tick(1000);
	assert.equal(manager.status(started.taskId).results[1].state, "queued");
	releaseFirst.resolve(); await secondReady.promise;
	t.mock.timers.tick(99); assert.equal(secondSignal.aborted, false);
	t.mock.timers.tick(1);
	const final = await started.done;
	assert.equal(final.results[0].state, "completed");
	assert.equal(final.results[0].timedOut, undefined);
	assert.equal(final.results[1].timedOut, true);
});

test("parallel timeout leaves an already-running sibling active", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const ready = [deferred(), deferred()]; const finishSibling = deferred(); let siblingSignal!: AbortSignal;
	t.after(() => finishSibling.resolve());
	const { manager } = await fixture(t, async (input, _files, signal) => {
		if (input.task === "sibling") { siblingSignal = signal; ready[1].resolve(); await Promise.race([finishSibling.promise, aborted(signal)]); }
		else { ready[0].resolve(); await aborted(signal); }
		return result(input);
	});
	const started = await manager.start(run({ mode: "parallel", tasks: [task(), task({ task: "sibling", timeoutMs: 0 })] }));
	await Promise.all(ready.map((entry) => entry.promise));
	t.mock.timers.tick(100);
	assert.equal(siblingSignal.aborted, false);
	finishSibling.resolve();
	const final = await started.done;
	assert.equal(final.state, "failed");
	assert.deepEqual(final.results.map((entry) => entry.state), ["failed", "completed"]);
});

test("chain timeout skips subsequent steps and releases the writer reservation only after cleanup", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const ready = deferred(); const cleaning = deferred(); const finishCleanup = deferred(); let launches = 0;
	t.after(() => finishCleanup.resolve());
	const { manager } = await fixture(t, async (input, _files, signal) => {
		if (++launches > 1) return result(input);
		ready.resolve(); await aborted(signal); cleaning.resolve(); await finishCleanup.promise;
		return result(input);
	}, { concurrency: 1 });
	const writable = task({ readOnly: false });
	const started = await manager.start(run({ mode: "chain", background: true, tasks: [writable, writable] }));
	await ready.promise; t.mock.timers.tick(100); await cleaning.promise;
	assert.equal(manager.status(started.taskId).results[0].state, "cancelling");
	assert.equal(manager.status(started.taskId).results[0].timedOut, true);
	await assert.rejects(manager.start(run({ tasks: [writable] })), /conflicts/);
	const queued = await manager.start(run({ background: true, tasks: [task({ task: "queued", timeoutMs: 0 })] }));
	assert.equal(manager.status(queued.taskId).results[0].state, "queued");
	assert.equal(launches, 1);
	finishCleanup.resolve();
	const final = await started.done;
	assert.deepEqual(final.results.map((entry) => entry.state), ["failed", "skipped"]);
	assert.equal((await queued.done).state, "completed");
	assert.equal(launches, 2);
	assert.equal((await (await manager.start(run({ tasks: [writable] }))).done).state, "completed");
});

test("completed children clear their deadline and are not aborted when a sibling is cancelled", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const clear = t.mock.method(globalThis, "clearTimeout");
	const siblingReady = deferred(); const completed = deferred(); let completedSignal!: AbortSignal;
	const { manager } = await fixture(t, async (input, _files, signal) => {
		if (input.task === "sibling") { siblingReady.resolve(); await aborted(signal); }
		else { completedSignal = signal; completed.resolve(); }
		return result(input);
	});
	const started = await manager.start(run({ mode: "parallel", background: true, tasks: [task(), task({ task: "sibling", timeoutMs: 0 })] }));
	await completed.promise; await siblingReady.promise;
	await manager.cancel(started.taskId);
	assert.equal(clear.mock.calls.length, 1);
	t.mock.timers.tick(1000);
	assert.equal(completedSignal.aborted, false);
	assert.equal(manager.status(started.taskId).results[0].timedOut, undefined);
});

for (const action of ["cancel", "cancelAll", "shutdown"] as const) test(`${action} before the deadline remains cancellation, not timeout`, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const ready = deferred();
	const { manager } = await fixture(t, async (input, _files, signal) => {
		ready.resolve(); await aborted(signal); return result(input);
	});
	const started = await manager.start(run({ background: true }));
	await ready.promise;
	const stopped = action === "cancel" ? manager.cancel(started.taskId) : manager[action]();
	t.mock.timers.tick(1000);
	await stopped;
	const final = await started.done;
	assert.equal(final.state, "cancelled");
	assert.equal(final.results[0].timedOut, undefined);
});

test("group cancellation after a timeout preserves that child's original failure cause", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const ready = deferred(); const cleaning = deferred(); const finishCleanup = deferred();
	t.after(() => finishCleanup.resolve());
	const { manager } = await fixture(t, async (input, _files, signal) => {
		ready.resolve(); await aborted(signal); cleaning.resolve(); await finishCleanup.promise;
		return result(input);
	});
	const started = await manager.start(run({ background: true }));
	await ready.promise; t.mock.timers.tick(100); await cleaning.promise;
	const cancelled = manager.cancel(started.taskId);
	finishCleanup.resolve(); await cancelled;
	const final = await started.done;
	assert.equal(final.state, "cancelled");
	assert.equal(final.results[0].state, "failed");
	assert.equal(final.results[0].timedOut, true);
	assert.match(final.results[0].errorMessage!, /timed out/);
});

test("runner rejection after timeout retains partial snapshots and the timeout cause", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const ready = deferred();
	const { manager } = await fixture(t, async (input, _files, signal, update) => {
		update(result(input)); ready.resolve(); await aborted(signal); throw new Error("runner aborted");
	});
	const started = await manager.start(run());
	await ready.promise; t.mock.timers.tick(100);
	const final = await started.done;
	assert.equal(final.results[0].timedOut, true);
	assert.match(final.results[0].errorMessage!, /timed out/);
	assert.equal(final.results[0].output, "partial evidence");
	assert.equal(final.usage?.input, 10);
});
