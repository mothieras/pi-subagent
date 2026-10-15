import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { emptyUsage, type ResolvedTask, type RunnerFiles, type SingleResult, type UsageStats } from "../contracts.ts";
import { aggregateUsage, createProcessRunner, getFinalOutput, getPiInvocation, type ProcessRunnerOptions } from "../process-runner.ts";
import { SessionTasks } from "../tasks.ts";

const fakeScript = String.raw`
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
const mode = process.argv[2];
const data = JSON.parse(process.argv[3]);
const emit = (event) => fs.writeSync(1, JSON.stringify(event) + '\n');
const ready = {type:'subagent_ready', model:'acme/test', thinking:'high', tools:['read']};
if (data.invocationPath) fs.writeFileSync(data.invocationPath, JSON.stringify({
  args:process.argv.slice(4), cwd:process.cwd(), config:process.env.PI_SUBAGENT_CONFIG,
  child:process.env.PI_SUBAGENT_CHILD, contents:JSON.parse(fs.readFileSync(process.env.PI_SUBAGENT_CONFIG,'utf8'))
}));
if (data.pidPath && !mode.startsWith('descendant')) fs.writeFileSync(data.pidPath, String(process.pid));
if (['hang','graceful','invalid-hang','oversize-hang'].includes(mode)) {
  setInterval(()=>{}, 1000);
  process.on('SIGTERM', () => {
    if (mode === 'graceful') { if(data.summary) emit(data.summary); process.exit(0); }
  });
}
if (mode.startsWith('descendant')) {
  const code = "const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);fs.writeFileSync(process.argv[1],String(process.pid));";
  const child = spawn(process.execPath, ['-e',code,data.descendantPath], {stdio:data.inheritPipes ? 'inherit' : 'ignore', detached:!!data.detached});
  fs.writeFileSync(data.pidPath, String(process.pid));
  for (let i=0; i<200 && !fs.existsSync(data.descendantPath); i++) await delay(5);
  if (!fs.existsSync(data.descendantPath)) process.exit(12);
  emit(ready);
  if (mode === 'descendant-exit') process.exit(0);
  process.on('SIGTERM',()=>process.exit(0));
  setInterval(()=>{},1000);
} else {
  if (!['missing-ready','raw','split'].includes(mode)) emit(data.ready ?? ready);
  if (mode === 'split') {
    const buffer=Buffer.from([ready,...data.records].map(JSON.stringify).join('\r\n')+'\r\n');
    for(let i=0;i<buffer.length;i++) { fs.writeSync(1,buffer.subarray(i,i+1)); await tick(); }
  } else {
    if(data.privateSummary) fs.writeSync(3,JSON.stringify(data.privateSummary)+'\n');
    for (const event of data.records ?? []) emit(event);
  }
  if (data.stderr) {
    const buffer=Buffer.from(data.stderr);
    for(let i=0;i<buffer.length;i+=7) fs.writeSync(2,buffer.subarray(i,i+7));
  }
  if (data.raw) fs.writeSync(1,Buffer.from(data.raw,'base64'));
  if (mode === 'invalid-hang') fs.writeSync(1,'not-json\n');
  if (mode === 'oversize-hang') fs.writeSync(1,'x'.repeat(200000));
  if (data.signal) process.kill(process.pid,data.signal);
  if (data.exitCode) process.exit(data.exitCode);
}
`;

function fixture(t: TestContext, taskOverrides: Partial<ResolvedTask> = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-runner-"));
	const files: RunnerFiles = {
		dir, configPath: path.join(dir, "config.json"), logPath: path.join(dir, "log.txt"), outputPath: path.join(dir, "output.txt"),
	};
	const task: ResolvedTask = {
		agent: "tester", agentSource: "inline", shadowedFiles: [], task: "Inspect safely", cwd: dir,
		model: "acme/test", thinking: "high", rolePrompt: "Offline test role", tools: { allow: ["read"], extensions: [], mcp: [] },
		readOnly: true, provenance: {}, ...taskOverrides,
	};
	fs.writeFileSync(files.configPath, JSON.stringify({ task, mcpServers: [] }));
	const script = path.join(dir, "fake.mjs");
	fs.writeFileSync(script, fakeScript);
	const controller = new AbortController();
	const pidPath = path.join(dir, "pid");
	const descendantPath = path.join(dir, "descendant");
	t.after(() => {
		controller.abort();
		if (process.platform !== "win32" && fs.existsSync(pidPath)) {
			try { process.kill(-Number(fs.readFileSync(pidPath, "utf8")), "SIGKILL"); } catch { /* already reaped */ }
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const run = (mode = "normal", data: Record<string, unknown> = {}, options: ProcessRunnerOptions = {}, update: (r: SingleResult) => void = () => {}) =>
		createProcessRunner({
			killGraceMs: 60, updateIntervalMs: 0, invocation: (args) => ({ command: process.execPath, args: [script, mode, JSON.stringify({ pidPath, ...data }), ...args] }),
			...options,
		})(task, files, controller.signal, update);
	return { dir, files, task, controller, script, pidPath, descendantPath, run };
}
function usage(input: number, output = 2) {
	return {
		input, output, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 1, reasoning: 1,
		totalTokens: input + output + 7, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
	};
}
function assistant(text = "answer", input = 10, extra: Record<string, unknown> = {}) {
	return { role: "assistant", content: [{ type: "text", text }], api: "test", provider: "acme", model: "test",
		usage: usage(input), stopReason: "stop", timestamp: input, ...extra };
}
function end(message: unknown) { return { type: "message_end", message }; }
function summary(overrides: Partial<UsageStats> = {}, complete = true) {
	return { type: "subagent_usage", usage: { ...emptyUsage(), input: 900, output: 80, totalTokens: 980, contextTokens: 500, turns: 4, ...overrides }, complete };
}
function partial(input = 20, output = 5) {
	return { type: "message_update", usage: usage(input, output), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial 🌍" } };
}
async function gone(pid: number) {
	for (let attempt = 0; attempt < 200; attempt++) {
		try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; }
		// A reparented Linux zombie is terminated, even if PID 1 has not reaped it yet.
		if (process.platform === "linux") {
			try { if (/^\d+ \(.+\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))) return true; } catch { return true; }
		}
		await delay(10);
	}
	return false;
}

test("invocation is isolated, honors resolved tools, passes config privately and protects positional tasks", async (t) => {
	for (const text of ["--model untrusted", "@not-a-real-file"]) {
		const f = fixture(t, { task: text });
		const invocationPath = path.join(f.dir, "invocation.json");
		const previous = [process.env.PI_SUBAGENT_CONFIG, process.env.PI_SUBAGENT_CHILD];
		const result = await f.run("normal", { invocationPath, records: [end(assistant())] }, { childExtensionPath: "/trusted child.ts" });
		assert.equal(result.state, "completed");
		const invoked = JSON.parse(fs.readFileSync(invocationPath, "utf8"));
		assert.deepEqual(invoked.args, ["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-mcp", "--no-skills",
			"--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline", "-e", "/trusted child.ts",
			"--model", "acme/test", "--thinking", "high", "--tools", "read", "--", `Task: ${text}`]);
		assert.equal(fs.realpathSync(invoked.cwd), fs.realpathSync(f.task.cwd));
		assert.equal(invoked.config, f.files.configPath);
		assert.equal(invoked.child, "1");
		assert.deepEqual(invoked.contents, { task: f.task, mcpServers: [] });
		assert.deepEqual([process.env.PI_SUBAGENT_CONFIG, process.env.PI_SUBAGENT_CHILD], previous);
		assert.equal(result.model, "acme/test");
		assert.equal(result.thinking, "high");
	}
});

test("empty allowlist uses --no-tools and ready supplies actual clamped metadata", async (t) => {
	const f = fixture(t, { tools: { allow: [], extensions: [], mcp: [] } });
	const invocationPath = path.join(f.dir, "invocation.json");
	const result = await f.run("normal", { invocationPath, ready: { type: "subagent_ready", model: "acme/test", thinking: "off", tools: [] } });
	const args: string[] = JSON.parse(fs.readFileSync(invocationPath, "utf8")).args;
	assert.ok(args.includes("--no-tools"));
	assert.ok(!args.includes("--tools"));
	assert.equal(result.thinking, "off");
	assert.deepEqual(result.resolved?.tools.allow, []);
	assert.equal(f.task.thinking, "high");
});

test("LF-only decoding survives byte-split UTF-8, CRLF, Unicode separators and joins the last assistant's text blocks", async (t) => {
	const f = fixture(t);
	const message = assistant("old");
	const last = assistant("ignored", 11, { content: [
		{ type: "text", text: "你好 🌍\u2028valid" }, { type: "thinking", thinking: "not output" }, { type: "text", text: "next\u2029part" },
	] });
	const records = [end(message), end(last), end({ role: "toolResult", toolCallId: "last", toolName: "read", content: [{ type: "text", text: "tool output" }], isError: false, timestamp: 20 })];
	const result = await f.run("split", { records });
	assert.equal(result.state, "completed");
	assert.equal(result.output, "你好 🌍\u2028valid\nnext\u2029part");
	assert.equal(fs.readFileSync(f.files.outputPath, "utf8"), result.output);
	assert.equal(getFinalOutput(result.messages), result.output);
	assert.equal(result.outputTruncated, false);
	assert.equal(result.usage.input, 21);
	assert.equal(result.usage.turns, 2);
});

test("only message_end accounts assistant/tool usage; streaming, turn, execution and agent events never double-count", async (t) => {
	const f = fixture(t);
	const message = assistant();
	const tool = { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [], usage: usage(5, 1), isError: false, timestamp: 12 };
	const result = await f.run("normal", { records: [
		{ type: "message_start", message: { ...message, stopReason: "pending" } }, partial(99), partial(100),
		end(message), end(message), { type: "turn_end", message, toolResults: [tool] },
		{ type: "tool_execution_end", toolCallId: "tool-1", result: { usage: tool.usage } },
		end(tool), end({ ...tool, timestamp: 13 }), { type: "agent_end", messages: [message, tool] },
	] });
	assert.equal(result.state, "completed");
	assert.equal(result.usage.input, 15);
	assert.equal(result.usage.output, 3);
	assert.equal(result.usage.cacheRead, 6);
	assert.equal(result.usage.cacheWrite, 8);
	assert.equal(result.usage.cacheWrite1h, 2);
	assert.equal(result.usage.reasoning, 2);
	assert.equal(result.usage.totalTokens, 32);
	assert.equal(result.usage.cost, 2);
	assert.deepEqual(result.usage.costBreakdown, { input: 0.2, output: 0.4, cacheRead: 0.6, cacheWrite: 0.8 });
	assert.equal(result.usage.contextTokens, 19);
	assert.equal(result.usage.turns, 1);
	assert.equal(result.usageComplete, false);
	assert.equal(result.messages.length, 2);
});

test("compaction and attributed entries contribute once, including compaction's duplicate entry notification", async (t) => {
	const f = fixture(t);
	const compact = { summary: "summary", firstKeptEntryId: "first", usage: usage(30), tokensBefore: 100 };
	const entry = { type: "usage", id: "warm", kind: "cache_warm", usage: usage(40) };
	const result = await f.run("normal", { records: [end(assistant()),
		{ type: "compaction_end", result: compact }, { type: "entry_appended", entry: { type: "compaction", id: "compact", ...compact } },
		{ type: "entry_appended", entry }, { type: "entry_appended", entry },
		{ type: "entry_appended", entry: { type: "branch_summary", id: "branch", usage: usage(50) } },
	] });
	assert.equal(result.usage.input, 130);
	assert.equal(result.usage.cost, 4);
	assert.equal(result.usage.turns, 1);
	assert.equal(result.usage.contextTokens, 19);
});

test("settled/shutdown usage summaries REPLACE totals and retain every usage counter", async (t) => {
	const f = fixture(t);
	const total = summary({ cacheRead: 33, cacheWrite: 44, cacheWrite1h: 11, reasoning: 22, cost: 5,
		costBreakdown: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } });
	const result = await f.run("normal", { records: [end(assistant()), summary({}, false), total, total] });
	assert.deepEqual(result.usage, total.usage);
	assert.equal(result.usageComplete, true);
});

test("usage after a summary makes it incomplete again until the next summary", async (t) => {
	const f = fixture(t);
	const result = await f.run("normal", { records: [summary(), end(assistant())] });
	assert.equal(result.usage.input, 910);
	assert.equal(result.usage.turns, 5);
	assert.equal(result.usageComplete, false);
});

test("output and display messages are independently UTF-8 byte bounded; raw log/stderr stay bounded while pipes drain", async (t) => {
	const f = fixture(t);
	const records = Array.from({ length: 50 }, (_, index) => end(assistant(`${index}:` + "🌍".repeat(100), index + 1)));
	records.push(end(assistant("🌍🌍🌍 last", 100)));
	const result = await f.run("normal", { records, stderr: "diagnostic " + "错🌍".repeat(10000) }, {
		maxMessageBytes: 2048, maxLogBytes: 1500, maxOutputBytes: 9,
	});
	assert.equal(result.state, "completed");
	assert.equal(result.output, "🌍🌍");
	assert.equal(result.outputTruncated, true);
	assert.equal(fs.readFileSync(f.files.outputPath, "utf8"), "🌍🌍");
	assert.ok(fs.statSync(f.files.logPath).size <= 1500);
	assert.ok(Buffer.byteLength(result.stderr) <= 1500);
	assert.ok(!result.stderr.includes("\ufffd"));
	assert.equal(result.logTruncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) <= 2048);
	assert.ok(result.messages.length < records.length);
	assert.equal(result.usage.turns, records.length);
});

test("raw protocol and diagnostics are stored verbatim when within the log limit", async (t) => {
	const f = fixture(t);
	const records = [end(assistant("logged"))];
	const result = await f.run("normal", { records, stderr: "stderr diagnostic\n" });
	const log = fs.readFileSync(f.files.logPath, "utf8");
	assert.ok(log.includes(JSON.stringify(records[0]) + "\n"));
	assert.ok(log.includes("stderr diagnostic\n"));
	assert.equal(result.stderr, "stderr diagnostic\n");
	assert.equal(result.logTruncated, false);
});

test("zero byte storage limits still drain and account the complete protocol", async (t) => {
	const f = fixture(t);
	const result = await f.run("normal", { records: [end(assistant()), summary()], stderr: "diagnostic" }, { maxLogBytes: 0, maxOutputBytes: 0 });
	assert.equal(result.state, "completed");
	assert.equal(result.output, "");
	assert.equal(result.stderr, "");
	assert.equal(result.outputTruncated, true);
	assert.equal(result.logTruncated, true);
	assert.equal(fs.statSync(f.files.logPath).size, 0);
	assert.equal(fs.statSync(f.files.outputPath).size, 0);
	assert.equal(result.usageComplete, true);
});

test("missing ready, mismatched model and malformed guard metadata fail closed even on exit zero", async (t) => {
	const f = fixture(t);
	for (const [mode, data, expected] of [
		["missing-ready", { records: [end(assistant()), summary()] }, /subagent_ready/],
		["normal", { ready: { type: "subagent_ready", model: "wrong/model", thinking: "high", tools: [] } }, /model mismatch/],
		["normal", { ready: { type: "subagent_ready", model: "acme/test", thinking: "invalid", tools: [] } }, /metadata/],
		["normal", { records: [{ type: "subagent_usage", usage: { input: 1 }, complete: true }] }, /summary/],
	] as const) {
		const result = await f.run(mode, data);
		assert.equal(result.state, "failed");
		assert.notEqual(result.exitCode, 0);
		assert.match(result.errorMessage ?? "", expected);
		assert.equal(result.usageComplete, false);
	}
});

test("invalid JSON, invalid UTF-8, non-object records and incomplete trailing records are fatal", async (t) => {
	const f = fixture(t);
	for (const raw of [Buffer.from("bad-json\n"), Buffer.from("[]\n"), Buffer.from("null\n"), Buffer.from('{"type":"session"}'),
		Buffer.from([0xff, 0x0a]), Buffer.from('{"type":"session","text":"').subarray(0), Buffer.from([0xe4, 0xb8]),
	]) {
		const result = await f.run("normal", { records: [end(assistant()), summary()], raw: raw.toString("base64") });
		assert.equal(result.state, "failed");
		assert.match(result.errorMessage ?? "", /JSONL|UTF-8/);
		assert.equal(result.usage.input, 900);
		assert.equal(result.usageComplete, false);
	}
});

test("malformed/oversized unbounded producers are terminated with bounded storage and accounting retained", { timeout: 5000 }, async (t) => {
	for (const mode of ["invalid-hang", "oversize-hang"]) {
		const f = fixture(t);
		const result = await f.run(mode, { records: [end(assistant())] }, { maxMessageBytes: 1024, maxLogBytes: 2000 });
		assert.equal(result.state, "failed");
		assert.match(result.errorMessage ?? "", /JSONL/);
		assert.equal(result.usage.input, 10);
		assert.equal(result.usageComplete, false);
		assert.ok(fs.statSync(f.files.logPath).size <= 2000);
		assert.ok(await gone(Number(fs.readFileSync(f.pidPath, "utf8"))));
	}
});

test("nonzero exits, signals and terminal error/abort stop reasons are failures with bounded errors", async (t) => {
	for (const data of [{ exitCode: 7 }, { signal: "SIGTERM" }, { records: [end(assistant("error", 10, { stopReason: "error", errorMessage: "E".repeat(100000) }))] },
		{ records: [end(assistant("aborted", 10, { stopReason: "aborted" }))] }]) {
		const f = fixture(t);
		const result = await f.run("normal", { records: [end(assistant()), summary()], ...data });
		assert.equal(result.state, "failed");
		assert.notEqual(result.exitCode, 0);
		assert.ok(result.errorMessage);
		assert.ok(Buffer.byteLength(result.errorMessage!) <= 16 * 1024);
	}
});

test("spawn, invocation and artifact failures return structured failures without throwing", async (t) => {
	const f = fixture(t);
	const missing = await f.run("normal", {}, { invocation: () => ({ command: path.join(f.dir, "does-not-exist"), args: [] }) });
	assert.equal(missing.state, "failed");
	assert.match(missing.errorMessage ?? "", /ENOENT/);
	assert.equal(missing.usageComplete, false);
	assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
	const thrown = await f.run("normal", {}, { invocation: () => { throw new Error("cannot invoke"); } });
	assert.equal(thrown.state, "failed");
	assert.match(thrown.errorMessage ?? "", /cannot invoke/);
	let launched = false;
	const runner = createProcessRunner({ invocation: () => { launched = true; throw new Error("must not launch"); } });
	const failedLog = await runner(f.task, { ...f.files, logPath: path.join(f.dir, "absent", "log") }, f.controller.signal, () => {});
	assert.equal(failedLog.state, "failed");
	assert.equal(launched, false);
	const failedOutput = await runner(f.task, { ...f.files, outputPath: f.dir }, f.controller.signal, () => {});
	assert.equal(failedOutput.state, "failed");
	assert.equal(launched, false);
});

test("abort before launch (including during invocation) never spawns", async (t) => {
	const f = fixture(t);
	f.controller.abort();
	let invoked = false;
	const result = await f.run("normal", {}, { invocation: () => { invoked = true; throw new Error("not allowed"); } });
	assert.equal(result.state, "cancelled");
	assert.equal(invoked, false);
	assert.equal(fs.existsSync(f.files.logPath), false);
	assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
	const g = fixture(t);
	const during = await g.run("normal", {}, { invocation: (args) => {
		g.controller.abort();
		return { command: process.execPath, args: [g.script, "normal", JSON.stringify({ pidPath: g.pidPath }), ...args] };
	} });
	assert.equal(during.state, "cancelled");
	assert.equal(fs.existsSync(g.pidPath), false);
});

test("SIGTERM-ignoring child is SIGKILLed; cancellation retains latest partial usage without counting deltas twice", { timeout: 5000 }, async (t) => {
	const f = fixture(t);
	const started = Date.now();
	const result = await f.run("hang", { records: [end(assistant()), { type: "message_start", message: assistant("", 20) }, partial(20, 1), partial(20, 5)] }, {}, (r) => {
		assert.equal(r.exitCode, -1);
		if (r.usage.output === 7) f.controller.abort();
	});
	assert.equal(result.state, "cancelled");
	assert.equal(result.usage.input, 30);
	assert.equal(result.usage.output, 7);
	assert.equal(result.usage.turns, 2);
	assert.equal(result.usageComplete, false);
	assert.equal(result.output, "answer");
	assert.ok(Date.now() - started < 3000);
	assert.ok(await gone(Number(fs.readFileSync(f.pidPath, "utf8"))));
	assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
});

test("graceful cancellation uses shutdown summary instead of adding pending usage, and preserves completeness", { timeout: 5000 }, async (t) => {
	const f = fixture(t);
	const total = summary({ input: 123, output: 45, totalTokens: 168, turns: 2 });
	const result = await f.run("graceful", { records: [end(assistant()), partial()], summary: total }, { killGraceMs: 1000 }, (r) => {
		if (r.usage.input === 30) f.controller.abort();
	});
	assert.equal(result.state, "cancelled");
	assert.deepEqual(result.usage, total.usage);
	assert.equal(result.usageComplete, true);
	assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
});

for (const mode of ["hang", "graceful"]) test(`runtime deadline cleans up a real ${mode === "hang" ? "SIGTERM-ignoring" : "graceful"} child and preserves accounting`, { timeout: 8000 }, async (t) => {
	let manager: SessionTasks | undefined;
	t.after(async () => { await manager?.shutdown(); });
	const f = fixture(t, { timeoutMs: 2000 });
	const total = summary({ input: 123, output: 45, totalTokens: 168, turns: 2 });
	manager = new SessionTasks({
		tmpRoot: f.dir, workspace: async (cwd) => cwd,
		runner: createProcessRunner({ killGraceMs: 100, invocation: (args) => ({ command: process.execPath, args: [f.script, mode,
			JSON.stringify({ pidPath: f.pidPath, records: [end(assistant("checkpoint"))], summary: total }), ...args] }) }),
	});
	const started = await manager.start({ mode: "single", agentScope: "user", projectAgentsDir: null, tasks: [f.task], background: false, notify: true, allowSharedWrites: false });
	const final = await started.done;
	assert.equal(final.state, "failed");
	assert.equal(final.results[0].timedOut, true);
	assert.match(final.results[0].errorMessage!, /timed out after 2000 ms/);
	assert.equal(final.results[0].output, "checkpoint");
	assert.equal(final.results[0].usageComplete, mode === "graceful");
	assert.equal(manager.usage().input, mode === "graceful" ? 123 : 10);
	assert.match((await manager.read(started.taskId)).text, /checkpoint[\s\S]*timed out/);
	assert.ok(await gone(Number(fs.readFileSync(f.pidPath, "utf8"))));
});

test("authoritative aborted message does not duplicate previous streaming usage", async (t) => {
	const f = fixture(t);
	const result = await f.run("graceful", { records: [partial(), end(assistant("", 20, { stopReason: "aborted", usage: usage(20, 5) }))] }, {}, (r) => {
		if (r.usage.input === 20) f.controller.abort();
	});
	assert.equal(result.state, "cancelled");
	assert.equal(result.usage.input, 20);
	assert.equal(result.usage.output, 5);
	assert.equal(result.usage.turns, 1);
});

test("throwing/rejecting callbacks cannot orphan children; updates are isolated snapshots", { timeout: 5000 }, async (t) => {
	for (const reject of [false, true]) {
		const f = fixture(t);
		const result = await f.run("hang", { records: [end(assistant())] }, {}, (r) => {
			if (r.model) {
				if (reject) return Promise.reject(new Error("async callback failure")) as unknown as void;
				throw new Error("sync callback failure");
			}
		});
		assert.equal(result.state, "failed");
		assert.match(result.errorMessage ?? "", /callback failure/);
		assert.ok(await gone(Number(fs.readFileSync(f.pidPath, "utf8"))));
		assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
	}
	const g = fixture(t);
	const result = await g.run("normal", { records: [end(assistant())] }, {}, (r) => {
		r.usage.input = 99999; r.messages.length = 0; if (r.resolved) r.resolved.tools.allow.length = 0;
	});
	assert.equal(result.usage.input, 10);
	assert.equal(result.messages.length, 1);
	assert.deepEqual(g.task.tools.allow, ["read"]);
});

test("abort listeners and grace/drain timers are removed on success, failure and graceful cancellation", { timeout: 5000 }, async (t) => {
	const originalSet = globalThis.setTimeout;
	const originalClear = globalThis.clearTimeout;
	const pending = new Set<ReturnType<typeof setTimeout>>();
	globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
		const timer = originalSet(() => { pending.delete(timer); callback(...args); }, ms);
		pending.add(timer);
		return timer;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => { pending.delete(timer); originalClear(timer); }) as typeof clearTimeout;
	try {
		for (const mode of ["normal", "invalid-hang", "graceful"]) {
			const f = fixture(t);
			const baseline = () => {};
			f.controller.signal.addEventListener("abort", baseline);
			await f.run(mode, { records: [end(assistant()), partial(), end(assistant("final", 20))], summary: summary() }, { killGraceMs: 1000, updateIntervalMs: 100 }, (r) => {
				if (mode === "graceful" && r.model) f.controller.abort();
			});
			assert.deepEqual(getEventListeners(f.controller.signal, "abort"), [baseline]);
			assert.equal(pending.size, 0);
			f.controller.signal.removeEventListener("abort", baseline);
		}
	} finally {
		globalThis.setTimeout = originalSet;
		globalThis.clearTimeout = originalClear;
	}
});

test("POSIX process-group cleanup kills descendants even after the parent closes its pipes", { skip: process.platform === "win32", timeout: 8000 }, async (t) => {
	for (const inheritPipes of [false, true]) {
		const f = fixture(t);
		const result = await f.run("descendant", { descendantPath: f.descendantPath, inheritPipes }, {}, (r) => {
			if (r.model) f.controller.abort();
		});
		assert.equal(result.state, "cancelled");
		assert.ok(await gone(Number(fs.readFileSync(f.pidPath, "utf8"))));
		assert.ok(await gone(Number(fs.readFileSync(f.descendantPath, "utf8"))));
		assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
	}
});

test("POSIX descendant cleanup also happens on a normal parent exit", { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
	const f = fixture(t);
	const result = await f.run("descendant-exit", { descendantPath: f.descendantPath, inheritPipes: false });
	assert.equal(result.state, "completed");
	assert.ok(await gone(Number(fs.readFileSync(f.descendantPath, "utf8"))));
});

test("helpers use the current executable and aggregate subsets without double-counting", () => {
	assert.deepEqual(getPiInvocation(["--offline"]), { command: process.execPath, args: [process.argv[1], "--offline"] });
	const total = aggregateUsage([{ ...emptyUsage(), input: 10, output: 5, reasoning: 2, totalTokens: 15, contextTokens: 15 },
		{ ...emptyUsage(), input: 20, output: 6, cacheWrite: 4, cacheWrite1h: 3, totalTokens: 30, contextTokens: 30 }]);
	assert.equal(total.totalTokens, 45);
	assert.equal(total.output, 11);
	assert.equal(total.cacheWrite, 4);
	assert.equal(total.contextTokens, 30);
	assert.equal(getFinalOutput([]), "");
});
