import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { DefaultResourceLoader, discoverAndLoadExtensions, SettingsManager } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
const repository = path.resolve(".");
const hostRoot = path.join(repository, "node_modules/@earendil-works/pi-coding-agent");
const posixOnly = process.platform === "win32" ? "Tarball/CLI verification uses the Linux/macOS CI baseline" : false;

async function manifest() {
	return JSON.parse(await fs.readFile(path.join(repository, "package.json"), "utf8"));
}

function loopbackEnvironment(agentDir: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...source };
	for (const key of Object.keys(env)) if (/^(?:https?|all|no)_proxy$/i.test(key)) delete env[key];
	return { ...env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NO_PROXY: "*", no_proxy: "*" };
}

async function packedFixture(t: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-package-test-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	t.after(async () => {
		if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
		await fs.rm(root, { recursive: true, force: true });
	});
	const agentDir = path.join(root, "agent"); const cwd = path.join(root, "repo");
	await fs.mkdir(agentDir); await fs.mkdir(cwd);
	const userConfig = path.join(root, "npm-user.conf"); const globalConfig = path.join(root, "npm-global.conf");
	await fs.writeFile(userConfig, ""); await fs.writeFile(globalConfig, "");
	const { stdout } = await exec("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", root,
		"--cache", path.join(root, "npm-cache"), "--userconfig", userConfig, "--globalconfig", globalConfig],
		{ cwd: repository, timeout: 10000, maxBuffer: 1024 * 1024 });
	const [archive] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
	assert.ok(archive?.filename, stdout);
	await exec("tar", ["-xzf", path.join(root, archive.filename), "-C", root], { timeout: 5000 });
	const packageRoot = path.join(root, "package");
	await assert.rejects(fs.access(path.join(packageRoot, "node_modules")), "The artifact must not rely on bundled host packages");
	return { root, agentDir, cwd, packageRoot, files: archive.files.map((file) => file.path) };
}

test("npm manifest declares a public scoped package without bundling host peers or publication hooks", async () => {
	const pkg = await manifest();
	assert.equal(pkg.name, "@mothieras/pi-subagent");
	assert.equal(pkg.private, false);
	assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
	assert.ok(pkg.keywords.includes("pi-package"));
	assert.equal(pkg.type, "module");
	assert.equal(pkg.license, "MIT");
	assert.deepEqual(pkg.pi, { extensions: ["./index.ts"], prompts: ["./prompts"], skills: ["./skills"] });
	assert.ok(pkg.files.length > 0, "Use an explicit distribution allowlist");
	assert.ok(!pkg.files.includes("*") && !pkg.files.includes("."), "Do not publish the entire checkout");
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(pkg.peerDependencies[name], "*");
		assert.ok(!pkg.dependencies?.[name]);
	}
	assert.ok(!pkg.bundledDependencies?.length && !pkg.bundleDependencies?.length);
	for (const hook of ["prepack", "postpack", "prepare", "prepublish", "prepublishOnly", "publish", "postpublish"]) {
		assert.ok(!pkg.scripts[hook], `Keep packaging and publication explicit: ${hook}`);
	}
});

test("actual npm tarball contains runtime imports, optional resources and linked docs, but no development artifacts", { skip: posixOnly }, async (t) => {
	const f = await packedFixture(t);
	const rootModules = (await fs.readdir(repository)).filter((file) => file.endsWith(".ts"));
	for (const file of [...rootModules, "package.json", "compat/plan-mode.ts", "compat/plan-mode/index.ts",
		"agents/scout.md", "agents/planner.md", "agents/worker.md", "agents/reviewer.md",
		"prompts/implement.md", "prompts/implement-and-review.md", "prompts/scout-and-plan.md", "skills/pi-subagent/SKILL.md",
		"README.md", "INSTALL.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "LICENSE",
		"docs/API.md", "docs/upstream-example.md"]) {
		assert.ok(f.files.includes(file), `Missing distribution resource: ${file}`);
	}
	assert.ok(f.files.includes("child.ts"), "The private child bootstrap is required at runtime");
	for (const file of f.files) {
		assert.doesNotMatch(file, /(?:^|\/)(?:node_modules|tests|\.git|\.github|coverage)(?:\/|$)|(?:^|\/)(?:PLAN\.md|package-lock\.json|\.DS_Store|\.npmrc|\.env(?:\.[^/]+)?|[^/]+\.tsbuildinfo)$/);
		assert.ok(rootModules.includes(file) || /^(?:agents|compat|docs|prompts|skills)\//.test(file) ||
			/^(?:package\.json|README\.md|INSTALL\.md|AGENTS\.md|CONTRIBUTING\.md|SECURITY\.md|CHANGELOG\.md|LICENSE)$/.test(file),
			`Unexpected distribution file: ${file}`);
		const body = await fs.readFile(path.join(f.packageRoot, file), "utf8");
		if (file.endsWith(".ts")) {
			for (const match of body.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
				await assert.doesNotReject(fs.access(path.resolve(f.packageRoot, path.dirname(file), match[1])), `${file}: missing runtime import ${match[1]}`);
			}
		}
		if (file.endsWith(".md")) {
			for (const match of [...body.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g), ...body.matchAll(/^\[[^\]]+\]:\s+(\S+)/gm)]) {
				const target = match[1].split("#")[0];
				if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
				await assert.doesNotReject(fs.access(path.resolve(f.packageRoot, path.dirname(file), decodeURIComponent(target))), `${file}: broken packaged link ${target}`);
			}
		}
	}
	const packed = JSON.parse(await fs.readFile(path.join(f.packageRoot, "package.json"), "utf8"));
	assert.deepEqual(packed, await manifest());
	const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir,
		settingsManager: SettingsManager.inMemory({ packages: [f.packageRoot] }), noContextFiles: true, noThemes: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.deepEqual(loaded.extensions.map((extension) => extension.path), [path.join(f.packageRoot, "index.ts")]);
	assert.deepEqual(loaded.extensions.flatMap((extension) => [...extension.tools.keys()]).sort(), ["subagent", "subagent_task"]);
	assert.ok(!loaded.extensions.some((extension) => extension.commands.has("plan")), "Plan Mode stays opt-in");
	assert.equal(loaded.extensions.flatMap((extension) => [...extension.commands.keys()]).filter((name) => name === "subagents").length, 1);
	assert.deepEqual(loader.getSkills().diagnostics, []);
	assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), ["pi-subagent"]);
	assert.deepEqual(loader.getPrompts().diagnostics, []);
	assert.deepEqual(loader.getPrompts().prompts.map((prompt) => prompt.name).sort(), ["implement", "implement-and-review", "scout-and-plan"]);

	const extensions = path.join(f.agentDir, "extensions");
	await fs.mkdir(extensions);
	await fs.symlink(f.packageRoot, path.join(extensions, "subagent"), "dir");
	await fs.symlink(path.join(f.packageRoot, "compat/plan-mode"), path.join(extensions, "plan-mode"), "dir");
	const linked = await discoverAndLoadExtensions([], f.cwd, f.agentDir);
	assert.deepEqual(linked.errors, []);
	assert.deepEqual(linked.extensions.flatMap((extension) => [...extension.tools.keys()]).sort(), ["subagent", "subagent_task"]);
	assert.equal(linked.extensions.flatMap((extension) => [...extension.commands.keys()]).filter((name) => name === "plan").length, 1);
	assert.equal(linked.extensions.flatMap((extension) => [...extension.commands.keys()]).filter((name) => name === "subagents").length, 1);
});

test("unpacked package runs the shipped parent/child Pi CLI against a loopback fake provider despite hostile proxy defaults", { skip: posixOnly, timeout: 20000 }, async (t) => {
	const f = await packedFixture(t);
	const host = JSON.parse(await fs.readFile(path.join(hostRoot, "package.json"), "utf8"));
	const cli = path.join(hostRoot, host.bin.pi);
	await fs.access(cli);
	let proxyConnections = 0;
	const proxy = http.createServer((_req, res) => { res.writeHead(502); res.end(); });
	proxy.on("connection", () => { proxyConnections++; });
	proxy.on("connect", (_req, socket) => socket.destroy());
	t.after(async () => {
		proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve()));
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
	const requests: any[] = []; const errors: unknown[] = [];
	const server = http.createServer(async (req, res) => {
		try {
			let text = ""; for await (const chunk of req) text += chunk;
			const request = JSON.parse(text); requests.push(request);
			const child = request.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("Task: PACKAGED_CHILD_JOB"));
			const delta = child ? { content: "unpacked child succeeded" } : requests.length === 1 ?
				{ tool_calls: [{ index: 0, id: "delegate", type: "function", function: { name: "subagent", arguments: JSON.stringify({
					task: "PACKAGED_CHILD_JOB", config: { tools: { allow: [], extensions: [], mcp: [] } },
				}) } }] } : { content: "unpacked parent succeeded" };
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const record of [
				{ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] },
				{ choices: [], usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 } },
			]) res.write(`data: ${JSON.stringify({ id: `completion-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "test", ...record })}\n\n`);
			res.end("data: [DONE]\n\n");
		} catch (error) { errors.push(error); res.destroy(); }
	});
	t.after(async () => {
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await fs.writeFile(path.join(f.agentDir, "models.json"), JSON.stringify({ providers: { fake: {
		baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "offline-test-only", models: [{ id: "test", reasoning: false,
			input: ["text"], contextWindow: 8192, maxTokens: 256, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	await fs.writeFile(path.join(f.agentDir, "settings.json"), JSON.stringify({ packages: [f.packageRoot],
		compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" }));
	const running = exec(process.execPath, [cli, "--mode", "json", "--no-session", "--no-mcp", "--no-skills",
		"--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline", "--model", "fake/test", "--thinking", "off",
		"--tools", "subagent,subagent_task", "Delegate the package verification task."],
		{ cwd: f.cwd, env: loopbackEnvironment(f.agentDir, { ...process.env,
			HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl,
			ALL_PROXY: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" }), timeout: 15000, maxBuffer: 1024 * 1024 });
	running.child.stdin?.end();
	const { stdout, stderr } = await running;
	assert.deepEqual(errors, []);
	assert.equal(proxyConnections, 0, "Fake inference must never contact an ambient proxy");
	const records = stdout.trim().split("\n").map((line) => JSON.parse(line));
	const result = records.find((record) => record.type === "message_end" && record.message?.role === "toolResult" && record.message.toolName === "subagent");
	assert.ok(result, `${stderr}\n${stdout}`);
	assert.equal(result.message.isError, false, JSON.stringify(result));
	assert.equal(result.message.details.state, "completed", JSON.stringify(result));
	assert.equal(result.message.details.results[0].output, "unpacked child succeeded");
	assert.equal(result.message.details.results[0].usageComplete, true);
	assert.equal(result.message.details.results[0].usage.input, 23);
	assert.equal(result.message.details.results[0].usage.output, 7);
	assert.equal(requests.length, 3);
	assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name).sort(), ["subagent", "subagent_task"]);
	assert.ok(!requests[1].tools?.length, "The packaged child must honor the empty allowlist");
	assert.ok(records.some((record) => record.type === "message_end" && record.message?.role === "assistant" &&
		record.message.content?.some((part: any) => part.text === "unpacked parent succeeded")));
	assert.ok(!records.some((record) => record.type === "extension_error"), stderr);
});
