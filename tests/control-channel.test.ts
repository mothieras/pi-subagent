import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createProcessRunner } from "../process-runner.ts";
import { emptyUsage, type ResolvedTask, type RunnerFiles } from "../contracts.ts";

test("FD3 totals arriving before stdout messages are authoritative at close, not double-added", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-control-"));
	t.after(() => fs.rm(dir, { force: true, recursive: true }));
	const script = path.join(dir, "fake.mjs"); const usage = { ...emptyUsage(), input: 100, output: 10, turns: 1, totalTokens: 110 };
	await fs.writeFile(script, `import * as fs from 'node:fs';const emit=(fd,event)=>fs.writeSync(fd,JSON.stringify(event)+'\\n');emit(3,{type:'subagent_ready',model:'fake/test',thinking:'off',tools:[]});emit(3,{type:'subagent_usage',usage:${JSON.stringify(usage)},complete:true});setTimeout(()=>{emit(1,{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],model:'test',provider:'fake',usage:{input:100,output:10,totalTokens:110,cost:{total:0}},stopReason:'stop',timestamp:1}})},30);`);
	const task: ResolvedTask = { agent: "inline", agentSource: "inline", shadowedFiles: [], task: "x", cwd: dir, model: "fake/test", thinking: "off", rolePrompt: "", tools: { allow: [], extensions: [], mcp: [] }, readOnly: true, provenance: {} };
	const files: RunnerFiles = { dir, configPath: path.join(dir, "config.json"), logPath: path.join(dir, "log"), outputPath: path.join(dir, "out") };
	const result = await createProcessRunner({ invocation: () => ({ command: process.execPath, args: [script] }) })(task, files, new AbortController().signal, () => {});
	assert.equal(result.state, "completed"); assert.deepEqual(result.usage, usage); assert.equal(result.usageComplete, true);
});
test("cancellation captures detached descendant groups, including SIGTERM-ignoring servers", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-detached-"));
	const pidFile = path.join(dir, "pid"); const script = path.join(dir, "root.mjs");
	const controller = new AbortController();
	t.after(async () => {
		controller.abort();
		try { process.kill(-Number(await fs.readFile(pidFile, "utf8")), "SIGKILL"); } catch { /* reaped */ }
		await fs.rm(dir, { force: true, recursive: true });
	});
	await fs.writeFile(script, `import {spawn} from 'node:child_process';import * as fs from 'node:fs';const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);require('fs').writeFileSync(process.argv[1],String(process.pid))",${JSON.stringify(pidFile)}],{detached:true,stdio:'ignore'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(ready);fs.writeSync(3,JSON.stringify({type:'subagent_ready',model:'fake/test',thinking:'off',tools:[]})+'\\n')}},10);`);
	const task: ResolvedTask = { agent: "inline", agentSource: "inline", shadowedFiles: [], task: "x", cwd: dir, model: "fake/test", thinking: "off", rolePrompt: "", tools: { allow: [], extensions: [], mcp: [] }, readOnly: true, provenance: {} };
	const files = { dir, configPath: path.join(dir, "config"), outputPath: path.join(dir, "out"), logPath: path.join(dir, "log") };
	const result = await createProcessRunner({ invocation: () => ({ command: process.execPath, args: [script] }), killGraceMs: 100 })(task, files, controller.signal, (result) => { if (result.model) controller.abort(); });
	assert.equal(result.state, "cancelled"); const pid = Number(await fs.readFile(pidFile, "utf8"));
	let gone = false;
	for (let i = 0; i < 100; i++) {
		try { process.kill(pid, 0); } catch { gone = true; break; }
		if (process.platform === "linux") { try { if (/^\d+ \(.+\) Z /.test(await fs.readFile(`/proc/${pid}/stat`, "utf8"))) { gone = true; break; } } catch { gone = true; break; } }
		await delay(10);
	}
	assert.equal(gone, true, "detached server survived parent cancellation");
});
