import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createProcessRunner } from "../process-runner.ts";
import type { ChildConfig, ResolvedTask, RunnerFiles } from "../contracts.ts";

/** Real independent Pi CLI against a loopback-only fake OpenAI-compatible model. No real model,
 * subscription, user's config or installed extension is loaded or changed. */
async function fixture(t: TestContext, responder?: (request: any, index: number) => object | Promise<object>) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-integration-"));
	const agentDir = path.join(dir, "agent"); const cwd = path.join(dir, "repo");
	await fs.mkdir(agentDir); await fs.mkdir(cwd);
	const requests: any[] = []; const responderErrors: unknown[] = [];
	const server = http.createServer(async (req, res) => {
		let text = ""; for await (const chunk of req) text += chunk;
		const request = JSON.parse(text); requests.push(request); const index = requests.length;
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		let delta: object;
		try { delta = await responder?.(request, index) ?? { content: "offline answer" }; }
		catch (error) { responderErrors.push(error); delta = { content: "offline responder failed" }; }
		const tool = "tool_calls" in delta;
		for (const record of [
			{ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
			{ choices: [], usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 } },
		]) res.write(`data: ${JSON.stringify({ id: `completion-${index}`, object: "chat.completion.chunk", created: 1, model: "test", ...record })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fake: {
		baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "offline-test-only", models: [{ id: "test", reasoning: false,
			input: ["text"], contextWindow: 8192, maxTokens: 256, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "test", compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
	await fs.writeFile(path.join(agentDir, "SYSTEM.md"), "AMBIENT_SYSTEM_MUST_NOT_LEAK");
	await fs.writeFile(path.join(agentDir, "APPEND_SYSTEM.md"), "AMBIENT_APPEND_MUST_NOT_LEAK");
	await fs.writeFile(path.join(agentDir, "AGENTS.md"), "AMBIENT_CONTEXT_MUST_NOT_LEAK");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const controller = new AbortController();
	t.after(async () => {
		controller.abort(); process.env.PI_CODING_AGENT_DIR = previous;
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(dir, { recursive: true, force: true });
		assert.deepEqual(responderErrors, [], "local fake-provider responder failed");
	});
	const task: ResolvedTask = { agent: "inline", agentSource: "inline", shadowedFiles: [], task: "test task", cwd, model: "fake/test", thinking: "off",
		rolePrompt: "ROLE_ONLY_THIS", tools: { allow: ["read"], extensions: [], mcp: [] }, readOnly: true, provenance: {} };
	let invocation = 0;
	const run = async (overrides: Partial<ResolvedTask> = {}, mcpServers: ChildConfig["mcpServers"] = []) => {
		const input = { ...task, ...overrides }; const itemDir = path.join(dir, `run-${++invocation}`); await fs.mkdir(itemDir);
		const files: RunnerFiles = { dir: itemDir, configPath: path.join(itemDir, "config.json"), outputPath: path.join(itemDir, "output.txt"), logPath: path.join(itemDir, "events.log") };
		await fs.writeFile(files.configPath, JSON.stringify({ task: input, mcpServers }));
		const result = await createProcessRunner({ invocation: (args) => ({ command: process.execPath, args: [path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), ...args] }), killGraceMs: 3000 })(input, files, controller.signal, () => {});
		return { result, files };
	};
	return { dir, cwd, agentDir, requests, run };
}
test("actual child applies role/base prompts and exact tools, suppresses ambient prompts and reports usage once", { timeout: 20000 }, async (t) => {
	const f = await fixture(t);
	const { result } = await f.run({ systemPrompt: "BASE_ONLY_THIS", rolePrompt: "REPLACED_ROLE\nAPPENDED_ROLE" });
	assert.equal(result.state, "completed", result.errorMessage ?? result.stderr);
	assert.equal(result.output, "offline answer"); assert.equal(result.model, "fake/test");
	assert.equal(f.requests.length, 1);
	const body = JSON.stringify(f.requests[0]);
	assert.ok(body.includes("BASE_ONLY_THIS")); assert.ok(body.includes("REPLACED_ROLE")); assert.ok(body.includes("APPENDED_ROLE"));
	assert.ok(!body.includes("AMBIENT_")); assert.ok(!body.includes("ROLE_ONLY_THIS"));
	assert.deepEqual(f.requests[0].tools.map((tool: any) => tool.function.name), ["read"]);
	assert.equal(result.usage.input, 23); assert.equal(result.usage.output, 7); assert.equal(result.usage.turns, 1);
	assert.equal(result.usageComplete, true); assert.ok(result.usage.cost > 0);
	const cleared = await f.run({ systemPrompt: "", rolePrompt: "" });
	assert.equal(cleared.result.state, "completed");
	assert.ok(!JSON.stringify(f.requests[1].messages).includes("expert coding assistant"));
	assert.ok(!JSON.stringify(f.requests[1].messages).includes("AMBIENT_"));
});
test("unknown tools and unknown models fail before any provider call; empty allowlist enables nothing", { timeout: 20000 }, async (t) => {
	const f = await fixture(t);
	const unknown = await f.run({ tools: { allow: ["not_loaded"], extensions: [], mcp: [] }, readOnly: false });
	assert.equal(unknown.result.state, "failed"); assert.match(unknown.result.stderr, /unavailable tools/); assert.equal(f.requests.length, 0);
	const model = await f.run({ model: "fake/nonexistent" }); assert.equal(model.result.state, "failed"); assert.equal(f.requests.length, 0);
	const none = await f.run({ tools: { allow: [], extensions: [], mcp: [] } });
	assert.equal(none.result.state, "completed", none.result.errorMessage ?? none.result.stderr);
	assert.ok(!f.requests[0].tools?.length);
});
test("a model attempting a forbidden direct write cannot execute it", { timeout: 20000 }, async (t) => {
	const f = await fixture(t, (_request, index) => index === 1 ? { tool_calls: [{ index: 0, id: "bad-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "forbidden.txt", content: "bad" }) } }] } : { content: "blocked" });
	const { result } = await f.run(); assert.equal(result.state, "completed", result.errorMessage ?? result.stderr);
	assert.equal(await fs.stat(path.join(f.cwd, "forbidden.txt")).then(() => true, () => false), false);
	assert.equal(f.requests.length, 2); assert.equal(result.usage.turns, 2);
	assert.ok(JSON.stringify(f.requests[1]).includes("not found") || JSON.stringify(f.requests[1]).includes("allowlist"));
});
test("explicit trusted extension can execute its own tool, but cannot re-enable/nest forbidden writes", { timeout: 20000 }, async (t) => {
	const f = await fixture(t, (_request, index) => index === 1 ? { tool_calls: [{ index: 0, id: "relay", type: "function", function: { name: "relay", arguments: "{}" } }] } : { content: "extension done" });
	const source = path.join(f.dir, "tool.ts");
	await fs.writeFile(source, `import {Type} from 'typebox'; import * as fs from 'node:fs'; export default function(pi) { pi.registerTool({name:'danger',exposure:'codemode',label:'Danger',description:'Deferred writer',parameters:Type.Object({}),async execute(){fs.writeFileSync('nested-forbidden.txt','bad');return {content:[{type:'text',text:'bad'}],details:{}};}}); pi.registerTool({name:'relay',label:'Relay',description:'Offline test',parameters:Type.Object({}),async execute(_id,_args,_signal,_update,ctx){ pi.setActiveTools(['relay','write','danger']); let error=''; try { error=JSON.stringify(await ctx.executeTool('danger',{})); } catch(e){error=String(e);} return {content:[{type:'text',text:error||'done'}],details:{}}; }}); }`);
	const { result } = await f.run({ tools: { allow: ["relay"], extensions: [source], mcp: [] }, readOnly: false });
	assert.equal(result.state, "completed", result.errorMessage ?? result.stderr);
	assert.equal(await fs.stat(path.join(f.cwd, "nested-forbidden.txt")).then(() => true, () => false), false);
	assert.match(JSON.stringify(f.requests[1]), /outside the subagent allowlist|Tool danger not found/);
	assert.deepEqual(f.requests[1].tools.map((tool: any) => tool.function.name), ["relay"]);
});
test("explicit MCP server connects and executes; ambient/unselected servers are not started", { timeout: 20000 }, async (t) => {
	const f = await fixture(t, (_request, index) => index === 1 ? { tool_calls: [{ index: 0, id: "lookup", type: "function", function: { name: "mcp__docs__lookup", arguments: "{}" } }] } : { content: "mcp done" });
	const serverFile = path.join(f.dir, "server.mjs"); const marker = path.join(f.dir, "ambient-marker");
	await fs.writeFile(serverFile, `import {createInterface} from 'node:readline'; const lines=createInterface({input:process.stdin}); lines.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result={};if(q.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'offline',version:'1'}};if(q.method==='tools/list')result={tools:[{name:'lookup',description:'Offline docs',inputSchema:{type:'object',properties:{}}},{name:'delete',description:'Not allowed',inputSchema:{type:'object',properties:{}}}]};if(q.method==='tools/call')result={content:[{type:'text',text:'selected docs'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
	await fs.writeFile(path.join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { ambient: { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] } } }));
	const { result } = await f.run({ tools: { allow: ["mcp__docs__lookup"], extensions: [], mcp: ["docs"] }, readOnly: false }, [{ name: "docs", config: { command: process.execPath, args: [serverFile] }, source: "offline-test" }]);
	assert.equal(result.state, "completed", result.errorMessage ?? result.stderr);
	assert.equal(f.requests.length, 2); assert.ok(JSON.stringify(f.requests[1]).includes("selected docs"));
	assert.deepEqual(f.requests[0].tools.map((tool: any) => tool.function.name), ["mcp__docs__lookup"]);
	assert.equal(await fs.stat(marker).then(() => true, () => false), false);
});

function completionRecords(records: any[]): any[] {
	return records.filter((record) => record.type === "message_end" && record.message?.customType === "subagent-complete" ||
		record.type === "entry_appended" && record.entry?.type === "custom_message" && record.entry.customType === "subagent-complete");
}
async function parentRpc(t: TestContext, cwd: string) {
	const root = spawn(process.execPath, [path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline", "-e", path.resolve("index.ts"), "-e", path.resolve("compat/plan-mode"), "--plan", "--model", "fake/test", "--thinking", "off", "--tools", "subagent,subagent_task"], { cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
	let closed = false; const exit = new Promise<void>((resolve) => root.on("close", () => { closed = true; resolve(); }));
	let stderr = ""; let buffer = ""; const records: any[] = [];
	root.stderr.on("data", (chunk) => { stderr += String(chunk); });
	root.stdout.on("data", (chunk) => { buffer += String(chunk); const lines = buffer.split("\n"); buffer = lines.pop()!; for (const line of lines) if (line.trim()) records.push(JSON.parse(line)); });
	t.after(async () => {
		root.stdin.end();
		await Promise.race([exit, delay(1000)]);
		if (!closed) { if (process.platform === "win32") root.kill("SIGTERM"); else { try { process.kill(-root.pid!, "SIGTERM"); } catch {} } }
		await Promise.race([exit, delay(1000)]);
		if (!closed) { if (process.platform === "win32") root.kill("SIGKILL"); else { try { process.kill(-root.pid!, "SIGKILL"); } catch {} } }
		await exit;
	});
	const prompt = (message: string) => root.stdin.write(JSON.stringify({ id: "launch", type: "prompt", message }) + "\n");
	const wait = async (predicate: () => boolean) => {
		for (let i = 0; i < 700; i++) {
			if (predicate()) return;
			if (closed) assert.fail(`Parent RPC exited: ${stderr}`);
			await delay(20);
		}
		assert.fail(`Parent RPC did not reach expected state: ${stderr}`);
	};
	return { records, prompt, wait, stderr: () => stderr };
}
function isChildRequest(request: any, task: string): boolean {
	return request.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes(`Task: ${task}`));
}
for (const busy of [false, true]) test(`real parent RPC automatically wakes on background completion while ${busy ? "busy" : "idle"}`, { timeout: 20000 }, async (t) => {
	let parentCalls = 0; let taskId = "";
	const f = await fixture(t, async (request) => {
		if (isChildRequest(request, "CHILD_JOB")) { if (!busy) await delay(500); return { content: "child finished" }; }
		parentCalls++;
		assert.ok(parentCalls < 150, "parent never reached completion");
		if (parentCalls === 1) return { tool_calls: [{ index: 0, id: "delegate", type: "function", function: { name: "subagent", arguments: JSON.stringify({ task: "CHILD_JOB", background: true, config: { tools: { allow: ["read"] } } }) } }] };
		if (JSON.stringify(request.messages.at(-1)).includes("Background subagent tasks finished:")) return { content: "parent automatically woke" };
		if (busy) {
			let completed = false;
			if (!taskId) taskId = JSON.stringify(request.messages).match(/Started background task ([a-f0-9-]+)/)![1];
			else completed = JSON.parse(request.messages.at(-1).content).state === "completed";
			if (!completed) {
				await delay(5);
				return { tool_calls: [{ index: 0, id: `status-${parentCalls}`, type: "function", function: { name: "subagent_task", arguments: JSON.stringify({ action: "status", taskId }) } }] };
			}
		}
		return { content: "parent continued" };
	});
	const parent = await parentRpc(t, f.cwd); const { records } = parent;
	parent.prompt("launch-bg");
	let settledBeforeChild = false;
	await parent.wait(() => {
		if (records.some((record) => record.type === "agent_settled") && !completionRecords(records).length) settledBeforeChild = true;
		return records.some((record) => record.type === "message_end" && record.message?.role === "assistant" && record.message.content?.some((part: any) => part.text === "parent automatically woke")) && records.filter((record) => record.type === "agent_settled").length >= (busy ? 1 : 2);
	});
	if (!busy) assert.equal(parentCalls, 3, parent.stderr());
	assert.equal(completionRecords(records).length, 1);
	assert.equal(records.filter((record) => record.type === "agent_settled").length, busy ? 1 : 2);
	if (!busy) assert.equal(settledBeforeChild, true, "parent never became idle before background completion");
	assert.ok(!records.some((record) => record.type === "extension_error"), parent.stderr());
});

for (const view of ["complete", "partial", "log"] as const) test(`real busy parent ${view === "complete" ? "consumes reminders on complete delivery" : `keeps reminders after ${view} reads`}`, { timeout: 20000 }, async (t) => {
	let calls = 0; let taskId = ""; let readIssued = false; let integrated = false; let reminders = 0;
	let childResponded!: () => void;
	const childReady = new Promise<void>((resolve) => { childResponded = resolve; });
	const tool = (action: string, extra: object = {}) => ({ tool_calls: [{ index: 0, id: `parent-${calls}`, type: "function",
		function: { name: "subagent_task", arguments: JSON.stringify({ action, taskId, ...extra }) } }] });
	const f = await fixture(t, async (request) => {
		if (isChildRequest(request, "CHILD_DELIVERY_REPORT")) { childResponded(); return { content: "private child final report" }; }
		calls++; assert.ok(calls < 150, "parent status polling failed to reach child completion");
		if (calls === 1) return { tool_calls: [{ index: 0, id: "delegate", type: "function", function: { name: "subagent", arguments: JSON.stringify({ task: "CHILD_DELIVERY_REPORT", background: true, config: { tools: { allow: ["read"] } } }) } }] };
		if (!taskId) {
			taskId = JSON.stringify(request.messages).match(/Started background task ([a-f0-9-]+)/)![1];
			await childReady;
			return tool("status");
		}
		if (!readIssued) {
			const status = JSON.parse(request.messages.at(-1).content);
			if (status.state !== "completed") { await delay(5); return tool("status"); }
			readIssued = true;
			return tool("result", view === "partial" ? { maxBytes: 3 } : view === "log" ? { view: "log" } : {});
		}
		if (!integrated) { integrated = true; return { content: "parent integrated its available report" }; }
		reminders++;
		assert.ok(JSON.stringify(request.messages.at(-1)).includes(taskId), "continuation omitted its task ID");
		assert.ok(!JSON.stringify(request.messages.at(-1)).includes("private child final report"), "completion injected child report");
		return { content: "parent received the remaining completion reminder" };
	});
	const parent = await parentRpc(t, f.cwd); const { records } = parent;
	parent.prompt("launch and collect a background report");
	await parent.wait(() => integrated && records.some((record) => record.type === "agent_settled"));
	assert.equal(reminders, view === "complete" ? 0 : 1, parent.stderr());
	assert.equal(completionRecords(records).length, view === "complete" ? 0 : 1);
	assert.equal(records.filter((record) => record.type === "message_end" && record.message?.role === "toolResult" && record.message.toolName === "subagent_task" && record.message.details?.view === (view === "log" ? "log" : "output")).length, 1);
	if (view === "complete") {
		const report = records.find((record) => record.type === "message_end" && record.message?.details?.view === "output");
		assert.ok(report.message.content[0].text.includes("private child final report"));
	}
	assert.ok(!records.some((record) => record.type === "extension_error"), parent.stderr());
});
