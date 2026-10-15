import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getEventListeners } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emptyUsage, type ResolvedRun, type ResolvedTask, type RunChild, type SingleResult } from "../contracts.ts";
import { SessionTasks, workspaceForCwd } from "../tasks.ts";

const task = (overrides: Partial<ResolvedTask> = {}): ResolvedTask => ({ agent: "inline", agentSource: "inline", shadowedFiles: [], task: "test", cwd: process.cwd(), model: "fake/test", thinking: "off", rolePrompt: "", tools: { allow: ["read"], extensions: [], mcp: [] }, readOnly: true, provenance: {}, ...overrides });
const run = (overrides: Partial<ResolvedRun> = {}): ResolvedRun => ({ mode: "single", agentScope: "user", projectAgentsDir: null, tasks: [task()], background: false, notify: true, allowSharedWrites: false, ...overrides });
const result = (input: ResolvedTask, text = "done", failed = false): SingleResult => ({ agent: input.agent, agentSource: input.agentSource, task: input.task, exitCode: failed ? 1 : 0, state: failed ? "failed" : "completed", messages: [], stderr: "", usage: { ...emptyUsage(), input: 10, output: 5, totalTokens: 15, turns: 1, cost: 0.2 }, usageComplete: true, output: text, resolved: input });
async function fixture(t: TestContext, options: Partial<ConstructorParameters<typeof SessionTasks>[0]> = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tasks-test-"));
	const files: string[] = [];
	const runner: RunChild = async (input, storage, signal, update) => {
		files.push(storage.configPath);
		const current = result(input, input.task);
		update(current); update(current); // Repeated snapshots must not increment the ledger.
		await fs.writeFile(storage.outputPath, current.output!);
		await fs.writeFile(storage.logPath, "logged");
		return { ...current, state: signal.aborted ? "cancelled" : current.state };
	};
	const manager = new SessionTasks({ runner, workspace: async (cwd) => cwd, tmpRoot: dir, ...options });
	t.after(async () => { await manager.shutdown(); await fs.rm(dir, { recursive: true, force: true }); });
	return { manager, dir, files };
}
test("single task, repeated queries/progress and notification do not duplicate usage", async (t) => {
	let notifications = 0;
	const { manager, files } = await fixture(t, { onComplete: () => { notifications++; } });
	const started = await manager.start(run({ background: true }));
	const final = await started.done;
	assert.equal(final.state, "completed"); assert.equal(notifications, 1);
	for (let i = 0; i < 10; i++) { manager.status(started.taskId); manager.list(); await manager.read(started.taskId); }
	assert.equal(manager.usage().input, 10); assert.equal(manager.usage().cost, 0.2);
	assert.equal(await fs.stat(files[0]).then(() => true, () => false), false);
	assert.equal(manager.status(started.taskId).results[0].resolved?.tools.allow[0], "read");
	final.results[0].usage.input = 999;
	assert.equal(manager.usage().input, 10);
});
test("parallel jobs share a GLOBAL concurrency pool, preserve ordering and use independent cancellation", async (t) => {
	let active = 0; let max = 0;
	const runner: RunChild = async (input, files) => {
		active++; max = Math.max(max, active); await delay(20); active--;
		await fs.writeFile(files.outputPath, input.task); return result(input, input.task);
	};
	const { manager } = await fixture(t, { runner, concurrency: 2 });
	const a = await manager.start(run({ background: true, mode: "parallel", tasks: [task({ task: "a" }), task({ task: "b" }), task({ task: "c" })] }));
	const b = await manager.start(run({ background: true, mode: "parallel", tasks: [task({ task: "d" }), task({ task: "e" })] }));
	const [one, two] = await Promise.all([a.done, b.done]);
	assert.equal(max, 2); assert.deepEqual(one.results.map((r) => r.output), ["a", "b", "c"]);
	assert.deepEqual(two.results.map((r) => r.output), ["d", "e"]); assert.equal(manager.usage().input, 50);
});
test("chain expands previous text literally in CLI task and config, stops on failure", async (t) => {
	const inputs: string[] = [];
	const { manager } = await fixture(t, { runner: async (input, files) => {
		inputs.push(input.task); const config = JSON.parse(await fs.readFile(files.configPath, "utf8"));
		assert.equal(config.task.task, input.task);
		return result(input, inputs.length === 1 ? "$& $` ${literal}" : "failure", inputs.length === 2);
	} });
	const started = await manager.start(run({ mode: "chain", tasks: [task({ task: "first" }), task({ task: "next {previous} {previous}" }), task({ task: "must not run" })] }));
	const final = await started.done;
	assert.deepEqual(inputs, ["first", "next $& $` ${literal} $& $` ${literal}"]);
	assert.equal(final.state, "failed"); assert.equal(final.results[2].state, "skipped"); assert.equal(manager.usage().input, 20);
});
test("background detaches launching signal; foreground and explicit cancel retain reported usage", async (t) => {
	let startedResolve: () => void = () => {};
	let started = new Promise<void>((resolve) => { startedResolve = resolve; });
	const { manager } = await fixture(t, { runner: async (input, _files, signal, update) => {
		const partial = result(input); update(partial); startedResolve();
		await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
		return { ...partial, state: "cancelled", exitCode: 1 };
	} });
	const caller = new AbortController();
	const bg = await manager.start(run({ background: true }), caller.signal);
	await started; caller.abort(); await delay(10);
	assert.equal(manager.status(bg.taskId).state, "running");
	await manager.cancel(bg.taskId); assert.equal(manager.status(bg.taskId).state, "cancelled");
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	started = new Promise<void>((resolve) => { startedResolve = resolve; });
	const foreground = new AbortController();
	const fg = await manager.start(run(), foreground.signal); await started; foreground.abort();
	assert.equal((await fg.done).state, "cancelled"); assert.equal(manager.usage().input, 20);
	assert.equal(getEventListeners(foreground.signal, "abort").length, 0);
});
test("queued cancellation never launches remaining children and releases queue listeners", async (t) => {
	let launched = 0;
	const { manager } = await fixture(t, { concurrency: 1, runner: async (input, _files, signal) => {
		launched++;
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return { ...result(input), state: "cancelled", exitCode: 1 };
	} });
	const started = await manager.start(run({ mode: "parallel", background: true, tasks: [task(), task(), task()] }));
	while (!launched) await delay(1);
	await manager.cancel(started.taskId);
	assert.equal(launched, 1); assert.ok(manager.status(started.taskId).results.every((r) => r.state === "cancelled"));
	const items = manager.status(started.taskId).results;
	assert.equal(typeof items[0].elapsedMs, "number"); assert.equal(items[0].currentTool, undefined);
	assert.ok(items.slice(1).every((item) => item.startedAt === undefined && item.elapsedMs === undefined));
});
test("activity counts queued and cancelling child items without charging usage", async (t) => {
	let ready: () => void = () => {}; let launched = 0;
	const startedChild = new Promise<void>((resolve) => { ready = resolve; });
	const { manager } = await fixture(t, { concurrency: 1, runner: async (input, _files, signal, update) => {
		launched++; const partial = result(input); update(partial);
		await new Promise<void>((resolve) => {
			const abort = () => { update(partial); resolve(); };
			if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
			ready();
		});
		return { ...partial, state: "cancelled", exitCode: 1 };
	} });
	assert.deepEqual(manager.activity(), { active: 0, queued: 0 });
	const started = await manager.start(run({ mode: "parallel", background: true, tasks: [task(), task()] }));
	await startedChild;
	assert.deepEqual(manager.activity(), { active: 1, queued: 1 });
	const cancelled = manager.cancel(started.taskId);
	assert.equal(manager.status(started.taskId).results[0].state, "cancelling");
	assert.deepEqual(manager.activity(), { active: 1, queued: 1 });
	for (let i = 0; i < 10; i++) manager.activity();
	assert.equal(manager.usage().input, 10);
	await cancelled;
	assert.equal(launched, 1);
	assert.deepEqual(manager.activity(), { active: 0, queued: 0 });
	assert.equal(manager.usage().input, 10);
});
test("item activity excludes queueing, freezes on completion and is a pure detached snapshot", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1000 });
	const held = new Map<string, { finish: () => void; update: (value: SingleResult) => void }>();
	const { manager } = await fixture(t, { concurrency: 1, runner: async (input, _files, signal, update) => {
		await new Promise<void>((resolve) => {
			const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
			held.set(input.task, { finish, update });
			if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
		});
		return result(input);
	} });
	const started = await manager.start(run({ mode: "parallel", background: true, tasks: [task({ task: "first" }), task({ task: "second" })] }));
	while (!held.has("first")) await delay(1);
	let items = manager.status(started.taskId).results;
	assert.equal(items[0].startedAt, 1000); assert.equal(items[0].elapsedMs, 0);
	assert.equal(items[1].startedAt, undefined); assert.equal(items[1].elapsedMs, undefined);
	t.mock.timers.setTime(4000);
	held.get("first")!.update({ ...result(task()), startedAt: 9, finishedAt: 10, currentTool: "read", lastEventAt: 4000 });
	items = manager.status(started.taskId).results;
	assert.equal(items[0].startedAt, 1000); assert.equal(items[0].finishedAt, undefined); assert.equal(items[0].elapsedMs, 3000);
	assert.equal(items[0].currentTool, "read"); assert.equal(items[0].lastEventAt, 4000);
	const before = manager.usage();
	for (let i = 0; i < 10; i++) {
		const summary = manager.list()[0];
		assert.equal(summary.results[0].elapsedMs, 3000); assert.equal(summary.results[1].elapsedMs, undefined);
		summary.results[0].currentTool = "mutated";
	}
	assert.equal(manager.status(started.taskId).results[0].currentTool, "read");
	assert.deepEqual(manager.usage(), before);
	t.mock.timers.setTime(5000); held.get("first")!.finish();
	while (!held.has("second")) await delay(1);
	items = manager.status(started.taskId).results;
	assert.equal(items[0].finishedAt, 5000); assert.equal(items[0].elapsedMs, 4000); assert.equal(items[0].currentTool, undefined);
	assert.equal(items[1].startedAt, 5000); assert.equal(items[1].elapsedMs, 0);
	t.mock.timers.setTime(7000); held.get("second")!.finish();
	const final = await started.done;
	t.mock.timers.setTime(9000);
	assert.deepEqual(manager.list()[0].results.map((item) => item.elapsedMs), [4000, 2000]);
	assert.deepEqual(final.results.map((item) => item.elapsedMs), [4000, 2000]);
	assert.equal(manager.status(started.taskId).resultDelivered, false); assert.equal(manager.pendingNotifications().length, 1);
});
test("cancellation in the pre-launch update never starts a runner or runtime", async (t) => {
	const caller = new AbortController(); let launched = false;
	const { manager } = await fixture(t, { runner: async (input) => { launched = true; return result(input); } });
	const started = await manager.start(run(), caller.signal, (details) => {
		if (details.results[0].state === "running") caller.abort();
	});
	const final = await started.done;
	assert.equal(launched, false); assert.equal(final.state, "cancelled");
	assert.equal(final.results[0].startedAt, undefined); assert.equal(final.results[0].elapsedMs, undefined);
});
test("failed runner clears tool activity and unexecuted chain steps never acquire runtime", async (t) => {
	const { manager } = await fixture(t, { runner: async (input, _files, _signal, update) => {
		update({ ...result(input), currentTool: "read", lastEventAt: Date.now() });
		throw new Error("runner failed while a tool was active");
	} });
	const started = await manager.start(run({ mode: "chain", tasks: [task(), task()] }));
	const final = await started.done;
	assert.equal(final.results[0].state, "failed"); assert.equal(final.results[0].currentTool, undefined);
	assert.equal(typeof final.results[0].lastEventAt, "number"); assert.equal(typeof final.results[0].elapsedMs, "number");
	assert.ok(final.results[0].finishedAt! >= final.results[0].startedAt!);
	assert.equal(final.results[1].state, "skipped");
	assert.equal(final.results[1].startedAt, undefined); assert.equal(final.results[1].finishedAt, undefined); assert.equal(final.results[1].elapsedMs, undefined);
});
test("parallel writable loadouts require explicit shared-worktree consent; chains and separate trees are allowed", async (t) => {
	const { manager } = await fixture(t);
	const writable = task({ readOnly: false, tools: { allow: ["bash"], extensions: [], mcp: [] } });
	await assert.rejects(manager.start(run({ mode: "parallel", tasks: [writable, writable] })), /allowSharedWrites/);
	const approved = await manager.start(run({ mode: "parallel", tasks: [writable, writable], allowSharedWrites: true })); await approved.done;
	const chain = await manager.start(run({ mode: "chain", tasks: [writable, writable] })); await chain.done;
	const split = await manager.start(run({ mode: "parallel", tasks: [writable, { ...writable, cwd: "/another-tree" }] })); await split.done;
});
test("concurrent admission cannot bypass cross-job writer reservations; both writers need consent", async (t) => {
	const { manager } = await fixture(t, { runner: async (input, _files, signal) => {
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); return { ...result(input), state: "cancelled" };
	} });
	const request = run({ tasks: [task({ readOnly: false })], background: true, allowSharedWrites: true });
	const first = await manager.start(request);
	await assert.rejects(manager.start({ ...request, allowSharedWrites: false }), /conflicts/);
	const second = await manager.start(request);
	await Promise.all([manager.cancel(first.taskId), manager.cancel(second.taskId)]);
});
test("writer cancellation under Plan Mode leaves read-only jobs running", async (t) => {
	const { manager } = await fixture(t, { runner: async (input, _files, signal) => {
		await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
		return { ...result(input), state: "cancelled" };
	} });
	const writable = await manager.start(run({ background: true, tasks: [task({ readOnly: false })] }));
	const readonly = await manager.start(run({ background: true }));
	await manager.cancelWriters(); assert.equal(manager.status(writable.taskId).state, "cancelled");
	assert.ok(["queued", "running"].includes(manager.status(readonly.taskId).state ?? "")); await manager.cancel(readonly.taskId);
});
test("shutdown is idempotent, kills jobs, suppresses wakes, clears files and rejects new launches", async (t) => {
	let wakes = 0; let persisted = 0;
	const { manager, dir } = await fixture(t, { onComplete: () => { wakes++; }, onUsage: () => { persisted++; }, runner: async (input, _files, signal, update) => {
		update(result(input)); await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
		return { ...result(input), state: "cancelled" };
	} });
	const started = await manager.start(run({ background: true }));
	while (manager.status(started.taskId).state !== "running") await delay(1);
	const a = manager.shutdown(); const b = manager.shutdown(); assert.equal(a, b); await a;
	assert.equal(wakes, 0); assert.ok(persisted >= 1); assert.deepEqual(await fs.readdir(dir), []);
	await assert.rejects(manager.start(run()), /shutting down/);
});
test("shutdown racing preparation does not register/launch a task or leave config files", async (t) => {
	let resolve: () => void = () => {}; let entered: () => void = () => {};
	const wait = new Promise<void>((r) => { resolve = r; }); const prepared = new Promise<void>((r) => { entered = r; });
	let launched = false;
	const { manager, dir } = await fixture(t, { prepare: async (input) => { entered(); await wait; return { task: input, mcpServers: [] }; }, runner: async (input) => { launched = true; return result(input); } });
	const accepted = manager.start(run()); await prepared; const closed = manager.shutdown(); resolve();
	await assert.rejects(accepted, /cancelled/); await closed; assert.equal(launched, false); assert.deepEqual(await fs.readdir(dir), []);
});
test("notification disabled and foreground never wake; failing notification cannot lose results", async (t) => {
	let wakes = 0;
	const { manager } = await fixture(t, { onComplete: () => { wakes++; throw new Error("host gone"); } });
	for (const request of [run(), run({ background: true, notify: false }), run({ background: true })]) { const started = await manager.start(request); assert.equal((await started.done).state, "completed"); }
	assert.equal(wakes, 1); assert.equal(manager.usage().input, 30);
});
test("retention evicts artifacts/tombstones but never loses or double-adds retired usage", async (t) => {
	const { manager } = await fixture(t, { maxRetainedJobs: 0 });
	const requests: string[] = [];
	for (let i = 0; i < 40; i++) { const started = await manager.start(run()); await started.done; requests.push(started.taskId); }
	assert.equal(manager.usage().input, 400); assert.equal(manager.list().length, 32);
	await assert.rejects(manager.read(requests.at(-1)!), /expired/); assert.throws(() => manager.status(requests[0]), /expired/);
	assert.equal(manager.usage().input, 400);
});
test("byte retention is bounded and parallel pruning cannot double-retire accounting", async (t) => {
	const { manager } = await fixture(t, { maxRetainedBytes: 1, maxRetainedJobs: 1 });
	for (let wave = 0; wave < 10; wave++) {
		const jobs = await Promise.all(Array.from({ length: 4 }, () => manager.start(run()))); await Promise.all(jobs.map((j) => j.done));
	}
	assert.equal(manager.usage().input, 400); assert.ok(manager.list().every((item) => item.expired));
});
test("result pages reconstruct UTF-8 output, reject invalid cursors and keep queries accounting-neutral", async (t) => {
	const { manager } = await fixture(t);
	const started = await manager.start(run({ tasks: [task({ task: "你好🌍abc" })] })); await started.done;
	const full = await manager.read(started.taskId); let cursor = 0; let joined = "";
	do { const page = await manager.read(started.taskId, { cursor, maxBytes: 3 }); joined += page.text; if (page.nextCursor === null) break; cursor = page.nextCursor; } while (true);
	assert.equal(joined, full.text); assert.ok(!joined.includes("\ufffd")); assert.equal(manager.usage().input, 10);
	await assert.rejects(manager.read(started.taskId, { cursor: -1 }), /Invalid/);
	await assert.rejects(manager.read(started.taskId, { cursor: 1000000 }), /exceeds/);
	assert.ok((await manager.read(started.taskId, { view: "log" })).text.includes("logged"));
});
test("baseline survives a new runtime without resurrecting jobs; active/pending limit fails before spawn", async (t) => {
	const { manager } = await fixture(t, { baselineUsage: { ...emptyUsage(), input: 100, cost: 3 }, maxActiveTasks: 1 });
	const started = await manager.start(run()); await started.done;
	assert.equal(manager.usage().input, 110); assert.equal(manager.usage().cost, 3.2);
	await assert.rejects(manager.start(run({ mode: "parallel", tasks: [task(), task()] })), /Too many/);
});
test("real workspace detection canonicalizes repo subdirectories, symlinks and separate worktrees", async (t) => {
	const { dir } = await fixture(t); const git = promisify(execFile);
	const repo = path.join(dir, "repo"); await fs.mkdir(repo); await git("git", ["init", "-q", repo]);
	await fs.mkdir(path.join(repo, "nested")); const link = path.join(dir, "link"); await fs.symlink(repo, link);
	assert.equal(await workspaceForCwd(path.join(repo, "nested")), await fs.realpath(repo));
	assert.equal(await workspaceForCwd(link), await fs.realpath(repo));
	const separate = path.join(dir, "plain"); await fs.mkdir(separate); assert.equal(await workspaceForCwd(separate), await fs.realpath(separate));
	await git("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Offline Test", "-c", "user.email=test@invalid", "commit", "--allow-empty", "-qm", "fixture"]);
	const worktree = path.join(dir, "worktree"); await git("git", ["-C", repo, "worktree", "add", "--detach", worktree]);
	assert.equal(await workspaceForCwd(worktree), await fs.realpath(worktree));
	assert.notEqual(await workspaceForCwd(worktree), await workspaceForCwd(repo));
});
