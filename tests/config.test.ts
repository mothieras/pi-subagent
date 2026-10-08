import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Value } from "typebox/value";
import { discoverAgents, formatAgentList } from "../agents.ts";
import type { AgentConfig } from "../agents.ts";
import { resolveRun } from "../config.ts";
import type { ResolveEnvironment } from "../config.ts";
import type { RunConfig, RunRequest } from "../contracts.ts";
import { RunConfigSchema, SubagentParams, TaskManagementParams } from "../schemas.ts";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-config-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const user = path.join(root, "user-agents");
	const project = path.join(root, "project");
	const projectAgentsDir = path.join(project, ".pi", "agents");
	const cwd = path.join(project, "src", "nested");
	for (const dir of [user, projectAgentsDir, cwd]) fs.mkdirSync(dir, { recursive: true });
	const write = (source: "user" | "project", filename: string, contents: string) => {
		const file = path.join(source === "user" ? user : projectAgentsDir, filename);
		fs.writeFileSync(file, contents);
		return file;
	};
	const role = (source: "user" | "project", name: string, fields = "", body = `${source} role body`, filename = `${name}.md`) =>
		write(source, filename, `---\nname: ${name}\ndescription: ${source} ${name}\n${fields}\n---\n${body}\n`);
	const discover = (scope: "user" | "project" | "both" = "user") => discoverAgents(cwd, scope, user);
	const environment = (overrides: Partial<ResolveEnvironment> = {}): ResolveEnvironment => ({
		cwd, parentModel: "acme/base", parentThinking: "high", agents: [], projectAgentsDir,
		availableModels: ["acme/base", "acme/fast", "other/slow", "acme/shared", "other/shared", "openrouter/org/id"],
		...overrides,
	});
	return { root, user, project, projectAgentsDir, cwd, write, role, discover, environment };
}

function only(request: RunRequest, environment: ResolveEnvironment) {
	return resolveRun(request, environment).tasks[0];
}

function unchecked(value: unknown): RunRequest {
	return value as RunRequest;
}

test("discovery defaults to user roles and never parses project roles implicitly", (t) => {
	const f = fixture(t);
	f.role("user", "scout", "tools: read, grep\nmodel: fast");
	f.role("project", "worker", "tools: false");
	const found = discoverAgents(f.cwd, undefined, f.user);
	assert.deepEqual(found.agents.map((agent) => agent.name), ["scout"]);
	assert.equal(found.projectAgentsDir, f.projectAgentsDir);
	assert.deepEqual(found.diagnostics, []);
	assert.equal(found.agents[0].source, "user");
	assert.deepEqual(found.agents[0].tools, ["read", "grep"]);
	assert.equal(found.agents[0].model, "fast");
	assert.equal(found.agents[0].systemPrompt, "user role body");
});

test("project-only discovery excludes user definitions and both records project overrides", (t) => {
	const f = fixture(t);
	const userFile = f.role("user", "scout", "tools: [read]", "user prompt");
	const projectFile = f.role("project", "scout", "tools: [read, grep]", "project prompt");
	f.role("user", "worker");
	const project = f.discover("project");
	assert.equal(project.agents.length, 1);
	assert.deepEqual(project.agents[0].shadowedFiles, []);
	const both = f.discover("both");
	assert.equal(both.agents.length, 2);
	const scout = both.agents.find((agent) => agent.name === "scout")!;
	assert.equal(scout.source, "project");
	assert.equal(scout.filePath, projectFile);
	assert.deepEqual(scout.shadowedFiles, [userFile]);
	const env = f.environment({ agents: both.agents });
	assert.equal(only({ agent: "scout", task: "look", agentScope: "both" }, env).rolePrompt, "project prompt");
	assert.equal(only({ agent: "project:scout", task: "look", agentScope: "both" }, env).agentFile, projectFile);
	const user = only({ agent: "user:scout", task: "look", agentScope: "both" }, env);
	assert.equal(user.agentFile, userFile);
	assert.equal(user.rolePrompt, "user prompt");
	assert.deepEqual(user.shadowedFiles, []);
	assert.equal(only({ agent: "scout", task: "look" }, env).agentSource, "user");
});

test("qualified names still obey explicit scope and missing role names fail", (t) => {
	const f = fixture(t);
	f.role("user", "reader");
	f.role("project", "writer");
	const env = f.environment({ agents: f.discover("both").agents });
	assert.equal(only({ agent: "user:reader", task: "read" }, env).agentSource, "user");
	assert.equal(only({ agent: "project:writer", task: "write", agentScope: "project" }, env).agentSource, "project");
	assert.throws(() => only({ agent: "project:writer", task: "write" }, env), /outside agentScope/);
	assert.throws(() => only({ agent: "user:reader", task: "read", agentScope: "project" }, env), /outside agentScope/);
	assert.throws(() => only({ agent: "writer", task: "write" }, env), /unavailable agent/);
	assert.throws(() => only({ agent: "unknown", task: "read", agentScope: "both" }, env), /unavailable agent/);
});

test("project discovery selects the nearest ancestor agents directory", (t) => {
	const f = fixture(t);
	f.role("project", "outer");
	const nearer = path.join(f.project, "src", ".pi", "agents");
	fs.mkdirSync(nearer, { recursive: true });
	fs.writeFileSync(path.join(nearer, "inner.md"), "---\nname: inner\ndescription: nearest\n---\nprompt");
	assert.equal(f.discover("project").projectAgentsDir, nearer);
	assert.deepEqual(f.discover("project").agents.map((agent) => agent.name), ["inner"]);
});

test("absent role directories and invalid scope are handled explicitly", (t) => {
	const f = fixture(t);
	const found = discoverAgents(f.root, "both", path.join(f.root, "missing"));
	assert.deepEqual(found.agents, []);
	assert.equal(found.projectAgentsDir, null);
	assert.deepEqual(found.diagnostics, []);
	assert.throws(() => discoverAgents(f.cwd, "invalid" as never, f.user), /agentScope/);
});

test("new YAML uses body as role prompt and preserves explicit system replacement", (t) => {
	const f = fixture(t);
	const file = f.role("user", "custom", `model: acme/fast
thinking: minimal
systemPrompt: ""
rolePrompt:
  append: extra instructions
tools:
  allow: [read, ls]
  extensions: [./extension.ts]
  mcp: [docs]`, "body instructions");
	const found = f.discover();
	assert.deepEqual(found.diagnostics, []);
	const agent = found.agents[0];
	assert.equal(agent.rolePrompt, "body instructions");
	assert.equal(agent.config?.thinking, "minimal");
	assert.equal(agent.config?.systemPrompt, "");
	assert.deepEqual(agent.config?.tools?.extensions, [path.join(f.user, "extension.ts")]);
	const resolved = only({ agent: "custom", task: "do it" }, f.environment({ agents: found.agents }));
	assert.equal(resolved.rolePrompt, "body instructions\n\nextra instructions");
	assert.equal(resolved.systemPrompt, "");
	assert.equal(resolved.model, "acme/fast");
	assert.equal(resolved.thinking, "minimal");
	assert.equal(resolved.agentFile, file);
	assert.equal(resolved.readOnly, false);
});

test("rolePrompt replace is independent from systemPrompt and supports empty replacement", (t) => {
	const f = fixture(t);
	f.role("user", "custom", 'systemPrompt: base replacement\nrolePrompt:\n  replace: ""\n  append: tail', "body");
	const result = only({ agent: "custom", task: "work" }, f.environment({ agents: f.discover().agents }));
	assert.equal(result.rolePrompt, "tail");
	assert.equal(result.systemPrompt, "base replacement");
});

test("BOM, CRLF, multiline YAML, delimiter whitespace and Markdown symlinks work", (t) => {
	const f = fixture(t);
	const original = path.join(f.root, "role-source.md");
	fs.writeFileSync(original, '\uFEFF---  \r\nname: linked\r\ndescription: linked role\r\nsystemPrompt: |\r\n  base\r\n  prompt\r\n--- \r\n\r\nBody\r\n');
	fs.symlinkSync(original, path.join(f.user, "role.MD"));
	const found = f.discover();
	assert.deepEqual(found.diagnostics, []);
	assert.equal(found.agents[0].rolePrompt, "Body");
	assert.equal(found.agents[0].config?.systemPrompt, "base\nprompt\n");
});

test("empty old CSV/list and new arrays never broaden into default tools", (t) => {
	const f = fixture(t);
	f.role("user", "csv", 'tools: ""');
	f.role("user", "list", "tools: []");
	f.role("user", "object", "tools:\n  allow: []\n  extensions: []\n  mcp: []");
	const found = f.discover();
	assert.deepEqual(found.diagnostics, []);
	for (const agent of found.agents) {
		assert.deepEqual(only({ agent: agent.name, task: "work" }, f.environment({ agents: found.agents })).tools.allow, []);
	}
});

const badFrontmatter: Array<[string, string, RegExp]> = [
	["numeric tools", "tools: 7", /tools.*expected an object/],
	["null tools", "tools: null", /tools.*expected an object/],
	["mixed tool list", "tools: [read, 7]", /tools.*list of strings/],
	["nested tool list", "tools: [[read]]", /tools.*list of strings/],
	["empty tool entry", 'tools: [read, ""]', /must not be empty/],
	["bad CSV", 'tools: "read,,bash"', /empty entry in CSV/],
	["allow scalar", "tools:\n  allow: read", /tools.allow.*array/],
	["extension scalar", "tools:\n  extensions: extension.ts", /tools.extensions.*array/],
	["MCP scalar", "tools:\n  mcp: docs", /tools.mcp.*array/],
	["tools typo", "tools:\n  alow: [read]", /unknown property.*alow/],
	["recursive tool", "tools: [subagent]", /recursive delegation/],
	["recursive management", "tools: [subagent_task]", /recursive delegation/],
	["wildcard tool", 'tools: ["*"]', /exact tool name/],
	["model scalar", "model: true", /model.*string/],
	["thinking value", "thinking: intense", /thinking.*expected/],
	["system scalar", "systemPrompt: [text]", /systemPrompt.*string/],
	["prompt scalar", "rolePrompt: text", /rolePrompt.*object/],
	["prompt typo", "rolePrompt:\n  replce: text", /unknown property.*replce/],
	["prompt null", "rolePrompt:\n  replace: null", /replace.*string/],
	["unknown option", "thnking: high", /unknown property.*thnking/],
	["duplicate YAML key", "model: base\nmodel: fast", /unique|duplicate/i],
	["invalid YAML", "tools: [read", /flow|collection|YAML|end/i],
];
for (const [name, fields, expected] of badFrontmatter) {
	test(`invalid frontmatter is diagnosed and excluded: ${name}`, (t) => {
		const f = fixture(t);
		const invalid = f.role("user", "invalid", fields);
		f.role("user", "valid", "tools: [read]");
		const found = f.discover();
		assert.deepEqual(found.agents.map((agent) => agent.name), ["valid"]);
		assert.equal(found.diagnostics.length, 1);
		assert.equal(found.diagnostics[0].filePath, invalid);
		assert.match(found.diagnostics[0].message, expected);
	});
}

for (const [name, contents] of [
	["missing header", "Body only"],
	["missing closing delimiter", "---\nname: invalid\ndescription: invalid\ntools: [read]"],
	["bad opening delimiter", "---bad\nname: invalid\ndescription: invalid\n---\nbody"],
	["bad closing delimiter", "---\nname: invalid\ndescription: invalid\n---bad\ntools: [read]\n---\nbody"],
	["scalar YAML", "---\nscalar\n---\nbody"],
	["array YAML", "---\n- item\n---\nbody"],
	["missing name", "---\ndescription: desc\n---\nbody"],
	["missing description", "---\nname: invalid\n---\nbody"],
	["invalid name", '---\nname: " "\ndescription: desc\n---\nbody'],
	["qualified definition", "---\nname: user:invalid\ndescription: desc\n---\nbody"],
] as const) {
	test(`malformed role envelope is diagnosed: ${name}`, (t) => {
		const f = fixture(t);
		f.write("user", "invalid.md", contents);
		const found = f.discover();
		assert.equal(found.agents.length, 0);
		assert.equal(found.diagnostics.length, 1);
	});
}

test("duplicate role names in a source are all rejected rather than chosen arbitrarily", (t) => {
	const f = fixture(t);
	f.role("user", "duplicate", "tools: [read]", "first", "first.md");
	f.role("user", "duplicate", "tools: [bash]", "second", "second.md");
	assert.equal(f.discover().agents.length, 0);
	assert.equal(f.discover().diagnostics.length, 2);
	assert.match(f.discover().diagnostics[0].message, /duplicate user role/);
});

test("broken symlinks and unreadable directories report diagnostics; non-Markdown files are ignored", (t) => {
	const f = fixture(t);
	fs.symlinkSync(path.join(f.root, "missing"), path.join(f.user, "broken.md"));
	f.write("user", "ignored.txt", "invalid content");
	fs.mkdirSync(path.join(f.user, "directory.md"));
	assert.equal(f.discover().diagnostics.length, 1);
	const notDirectory = path.join(f.root, "not-a-directory");
	fs.writeFileSync(notDirectory, "text");
	assert.equal(discoverAgents(f.cwd, "user", notDirectory).diagnostics.length, 1);
});

test("formatAgentList truncates predictably and preserves legacy formatting", () => {
	const agents = ["one", "two"].map((name): AgentConfig => ({ name, description: `${name} description`, source: "user", filePath: "/unused", systemPrompt: "" }));
	assert.deepEqual(formatAgentList([], 2), { text: "none", remaining: 0 });
	assert.deepEqual(formatAgentList(agents, 1), { text: "one (user): one description", remaining: 1 });
	assert.deepEqual(formatAgentList(agents, -1), { text: "none", remaining: 2 });
	assert.equal(formatAgentList(agents, Infinity).remaining, 0);
});

test("inline tasks need no role and inherit model/thinking, cwd and safe source defaults", (t) => {
	const f = fixture(t);
	const result = resolveRun({ task: "inspect" }, f.environment());
	assert.equal(result.mode, "single");
	assert.equal(result.agentScope, "user");
	assert.equal(result.projectAgentsDir, f.projectAgentsDir);
	assert.equal(result.background, false);
	assert.equal(result.notify, true);
	assert.equal(result.allowSharedWrites, false);
	const task = result.tasks[0];
	assert.equal(task.agent, "inline");
	assert.equal(task.agentSource, "inline");
	assert.equal(task.agentFile, undefined);
	assert.deepEqual(task.shadowedFiles, []);
	assert.equal(task.model, "acme/base");
	assert.equal(task.thinking, "high");
	assert.equal(task.cwd, f.cwd);
	assert.equal(task.rolePrompt, "");
	assert.equal(task.systemPrompt, undefined);
	assert.deepEqual(task.tools, { allow: ["read", "bash", "edit", "write"], extensions: [], mcp: [] });
	assert.equal(task.readOnly, false);
	assert.equal(task.provenance.model, "parent");
	assert.equal(task.provenance.thinking, "parent");
	assert.equal(task.provenance.cwd, "environment");
});

test("model selection only accepts exact canonical or unique exact bare IDs", (t) => {
	const f = fixture(t);
	for (const [requested, canonical] of [["acme/fast", "acme/fast"], ["fast", "acme/fast"], ["org/id", "openrouter/org/id"], ["openrouter/org/id", "openrouter/org/id"]]) {
		assert.equal(only({ task: "work", config: { model: requested } }, f.environment()).model, canonical);
	}
	assert.throws(() => only({ task: "work", config: { model: "shared" } }, f.environment()), /ambiguous model/);
	for (const model of ["fas", "FAST", "acme/fas", "acme/fast:high", "missing", "", " fast "]) {
		assert.throws(() => only({ task: "work", config: { model } }, f.environment()), /model/);
	}
});

test("model inheritance fails without a parent but an explicitly available model succeeds", (t) => {
	const f = fixture(t);
	const env = f.environment({ parentModel: undefined });
	assert.throws(() => only({ task: "work" }, env), /no parent model/);
	assert.throws(() => only({ task: "work", config: { model: "inherit" } }, env), /no parent model/);
	assert.equal(only({ task: "work", config: { model: "fast" } }, env).model, "acme/fast");
	assert.throws(() => only({ task: "work" }, f.environment({ availableModels: [] })), /unavailable model/);
});

test("without a registry only the known parent model is accepted, never an unchecked model", (t) => {
	const f = fixture(t);
	const env = f.environment({ availableModels: undefined });
	assert.equal(only({ task: "work", config: { model: "base" } }, env).model, "acme/base");
	assert.throws(() => only({ task: "work", config: { model: "other/new" } }, env), /unavailable model/);
	assert.throws(() => only({ task: "work" }, f.environment({ parentModel: "base", availableModels: undefined })), /unavailable model/);
});

test("canonical exact names take precedence over bare ID collisions", (t) => {
	const f = fixture(t);
	const env = f.environment({ availableModels: ["acme/fast", "openrouter/acme/fast"] });
	assert.equal(only({ task: "work", config: { model: "acme/fast" } }, env).model, "acme/fast");
});

test("an unavailable role model fails instead of falling back; a call may explicitly override it", (t) => {
	const f = fixture(t);
	f.role("user", "reader", "model: unavailable");
	const env = f.environment({ agents: f.discover().agents });
	assert.throws(() => only({ task: "work", agent: "reader" }, env), /unavailable model/);
	assert.equal(only({ task: "work", agent: "reader", config: { model: "fast" } }, env).model, "acme/fast");
});

test("thinking supports every agreed level, explicit inheritance and missing-parent off", (t) => {
	const f = fixture(t);
	for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		assert.equal(only({ task: "work", config: { thinking } }, f.environment()).thinking, thinking);
	}
	assert.equal(only({ task: "work", config: { model: "fast", thinking: "inherit" } }, f.environment()).thinking, "high");
	const inherited = only({ task: "work", config: { model: "inherit", thinking: "inherit" } }, f.environment());
	assert.equal(inherited.provenance.model, "parent");
	assert.equal(inherited.provenance["model.selection"], "call");
	assert.equal(inherited.provenance["thinking.selection"], "call");
	assert.equal(only({ task: "work" }, f.environment({ parentThinking: undefined })).thinking, "off");
});

test("leaf precedence is item > call > role > defaults; arrays replace, not union", (t) => {
	const f = fixture(t);
	f.role("user", "reader", `model: fast
thinking: low
systemPrompt: role base
rolePrompt:
  append: role append
tools:
  allow: [read, ls]
  extensions: [./role-extension.ts]
  mcp: [role_docs]`, "role body");
	const result = resolveRun({
		tasks: [{ agent: "reader", task: "work", config: { thinking: "max", rolePrompt: { append: "" }, tools: { allow: [] } } }],
		config: { model: "other/slow", systemPrompt: "", rolePrompt: { replace: "call prompt" }, tools: { mcp: [] } },
	}, f.environment({ agents: f.discover().agents, defaults: {
		model: "acme/base", thinking: "medium", rolePrompt: { replace: "default prompt", append: "default append" },
		tools: { allow: ["bash"], extensions: ["./default-extension.ts"], mcp: ["default_docs"] },
	} }));
	const task = result.tasks[0];
	assert.equal(task.model, "other/slow");
	assert.equal(task.thinking, "max");
	assert.equal(task.rolePrompt, "call prompt");
	assert.equal(task.systemPrompt, "");
	assert.deepEqual(task.tools.allow, []);
	assert.deepEqual(task.tools.mcp, []);
	assert.deepEqual(task.tools.extensions, [path.join(f.user, "role-extension.ts")]);
	assert.equal(task.provenance.model, "call");
	assert.equal(task.provenance.thinking, "item");
	assert.equal(task.provenance["rolePrompt.replace"], "call");
	assert.equal(task.provenance["rolePrompt.append"], "item");
	assert.equal(task.provenance["tools.allow"], "item");
	assert.equal(task.provenance["tools.extensions"], "role");
	assert.equal(task.provenance["tools.mcp"], "call");
});

test("role body outranks default replace, while unoverridden prompt leaves merge", (t) => {
	const f = fixture(t);
	f.role("user", "reader", "", "role body");
	const result = only({ task: "work", agent: "reader" }, f.environment({ agents: f.discover().agents,
		defaults: { rolePrompt: { replace: "default body", append: "default tail" } } }));
	assert.equal(result.rolePrompt, "role body\n\ndefault tail");
	assert.equal(result.provenance["rolePrompt.replace"], "role");
	assert.equal(result.provenance["rolePrompt.append"], "defaults");
});

test("paths are qualified in their source layer before merging, with invocation cwd for overrides", (t) => {
	const f = fixture(t);
	f.role("user", "reader", "tools:\n  allow: [read]");
	const env = f.environment({ agents: f.discover().agents, defaults: { tools: { extensions: ["./default.ts"] } } });
	const role = only({ agent: "reader", task: "work", cwd: f.project }, env);
	assert.deepEqual(role.tools.extensions, [path.join(f.cwd, "default.ts")]);
	const call = only({ agent: "reader", task: "work", cwd: f.project, config: { tools: { extensions: ["./call.ts"] } } }, env);
	assert.deepEqual(call.tools.extensions, [path.join(f.cwd, "call.ts")]);
	const item = resolveRun({ tasks: [{ task: "work", cwd: f.project, config: { tools: { extensions: ["./item.ts"] } } }],
		config: { tools: { extensions: ["./call.ts"] } } }, env).tasks[0];
	assert.deepEqual(item.tools.extensions, [path.join(f.cwd, "item.ts")]);
});

test("role paths stay role-relative after discovery in a different invocation directory", (t) => {
	const f = fixture(t);
	f.role("user", "reader", "tools:\n  extensions: [../plugin.ts]");
	const result = only({ agent: "reader", task: "work" }, f.environment({ agents: f.discover().agents, cwd: f.project }));
	assert.deepEqual(result.tools.extensions, [path.join(f.root, "plugin.ts")]);
});

test("absolute and home-relative extension paths are stable", (t) => {
	const f = fixture(t);
	const absolute = path.join(f.root, "absolute.ts");
	const task = only({ task: "work", config: { tools: { extensions: [absolute, "~/home.ts"] } } }, f.environment());
	assert.deepEqual(task.tools.extensions, [absolute, path.join(os.homedir(), "home.ts")]);
});

test("empty prompt strings and tool arrays survive every merge layer", (t) => {
	const f = fixture(t);
	const result = only({ task: "work", config: { rolePrompt: { replace: "", append: "" }, systemPrompt: "", tools: { allow: [], extensions: [], mcp: [] } } },
		f.environment({ defaults: { rolePrompt: { replace: "default", append: "tail" }, systemPrompt: "base", tools: { extensions: ["./plugin.ts"], mcp: ["docs"] } } }));
	assert.equal(result.rolePrompt, "");
	assert.equal(result.systemPrompt, "");
	assert.deepEqual(result.tools, { allow: [], extensions: [], mcp: [] });
	assert.equal(result.readOnly, true);
});

test("legacy AgentConfig aliases are supported for callers constructing old role objects", (t) => {
	const f = fixture(t);
	const agent: AgentConfig = { name: "old", description: "old", model: "fast", tools: ["read"],
		systemPrompt: "legacy role prompt", filePath: path.join(f.user, "old.md"), source: "user" };
	const result = only({ task: "work", agent: "old" }, f.environment({ agents: [agent] }));
	assert.equal(result.rolePrompt, "legacy role prompt");
	assert.equal(result.systemPrompt, undefined);
	assert.equal(result.model, "acme/fast");
	assert.equal(result.readOnly, true);
});

test("externally supplied user/project definitions also use project precedence and provenance", (t) => {
	const f = fixture(t);
	const make = (source: "user" | "project"): AgentConfig => ({ name: "same", description: "same", systemPrompt: source,
		source, filePath: path.join(source === "user" ? f.user : f.projectAgentsDir, "same.md") });
	const user = make("user");
	const project = make("project");
	const result = only({ task: "work", agent: "same", agentScope: "both" }, f.environment({ agents: [user, project] }));
	assert.equal(result.agentSource, "project");
	assert.deepEqual(result.shadowedFiles, [user.filePath]);
	assert.equal(result.agentFile, project.filePath);
	assert.equal(result.provenance["rolePrompt.replace"], "role");
	assert.throws(() => only({ task: "work", agent: "same" }, f.environment({ agents: [user, user] })), /ambiguous agent/);
});

test("task items inherit top-level cwd; explicit relative cwd resolves from invocation cwd", (t) => {
	const f = fixture(t);
	const result = resolveRun({ cwd: f.project, tasks: [{ task: "one" }, { task: "two", cwd: ".." }] }, f.environment());
	assert.equal(result.tasks[0].cwd, f.project);
	assert.equal(result.tasks[0].provenance.cwd, "call");
	assert.equal(result.tasks[1].cwd, path.dirname(f.cwd));
	assert.equal(result.tasks[1].provenance.cwd, "item");
	const chain = resolveRun({ cwd: f.project, chain: [{ task: "first" }, { task: "{previous}" }] }, f.environment());
	assert.equal(chain.mode, "chain");
	assert.equal(chain.tasks[1].cwd, f.project);
	assert.equal(chain.tasks[1].task, "{previous}");
});

test("cwd is validated for the environment, the call and every item", (t) => {
	const f = fixture(t);
	const missing = path.join(f.root, "missing");
	const file = path.join(f.root, "file");
	fs.writeFileSync(file, "text");
	for (const cwd of [missing, file, ""]) {
		assert.throws(() => only({ task: "work", cwd }, f.environment()), /directory|empty/);
		assert.throws(() => resolveRun({ tasks: [{ task: "work", cwd }] }, f.environment()), /directory|empty/);
		assert.throws(() => only({ task: "work" }, f.environment({ cwd })), /directory|empty/);
	}
});

test("parallel has a maximum of eight items and chains only require nonempty items", (t) => {
	const f = fixture(t);
	assert.equal(resolveRun({ tasks: Array.from({ length: 8 }, () => ({ task: "work" })) }, f.environment()).tasks.length, 8);
	assert.throws(() => resolveRun({ tasks: Array.from({ length: 9 }, () => ({ task: "work" })) }, f.environment()), /at most 8/);
	assert.equal(resolveRun({ chain: Array.from({ length: 9 }, () => ({ task: "work" })) }, f.environment()).tasks.length, 9);
});

test("background, notify and shared-write permission resolve explicitly", (t) => {
	const f = fixture(t);
	const result = resolveRun({ task: "work", background: true, notify: false, allowSharedWrites: true }, f.environment());
	assert.equal(result.background, true);
	assert.equal(result.notify, false);
	assert.equal(result.allowSharedWrites, true);
});

const badRequests: unknown[] = [
	{}, { agent: "reader" }, { task: "" }, { task: " \n " }, { task: 7 }, { agent: "", task: "work" },
	{ tasks: [] }, { chain: [] }, { tasks: {} }, { chain: null },
	{ task: "work", tasks: [] }, { task: "work", chain: [] }, { tasks: [{ task: "work" }], chain: [] },
	{ agent: "reader", tasks: [{ task: "work" }] }, { task: "work", tasks: undefined },
	{ tasks: [{ task: "work" }], agent: undefined },
	{ tasks: [{}] }, { chain: [{ agent: "reader" }] }, { tasks: [null] },
	{ task: "work", agentScope: "all" }, { task: "work", background: "true" },
	{ task: "work", notify: 1 }, { task: "work", allowSharedWrites: null },
	{ task: "work", confirmProjectAgents: false }, { task: "work", typo: true },
	{ tasks: [{ task: "work", typo: true }] }, { task: "work", config: { typo: true } },
	{ task: "work", config: { rolePrompt: { typo: "prompt" } } },
	{ task: "work", config: { tools: { alow: [] } } },
	{ task: "work", config: { tools: { allow: "read" } } },
	{ task: "work", config: { tools: { extensions: [1] } } },
	{ task: "work", config: { tools: { mcp: ["invalid/server"] } } },
	{ task: "work", config: { model: false } }, { task: "work", config: { thinking: "ultra" } },
	{ task: "work", config: { systemPrompt: null } }, { task: "work", config: { rolePrompt: "text" } },
	{ task: "work", config: null }, { task: "work", config: { tools: null } },
	{ task: "work", config: { rolePrompt: { append: undefined } } },
	{ task: "work", cwd: undefined }, { task: "work", agent: undefined },
];
for (const [index, request] of badRequests.entries()) {
	test(`runtime rejects malformed request independently of schema: ${index}`, (t) => {
		const f = fixture(t);
		assert.throws(() => resolveRun(unchecked(request), f.environment()));
	});
}

test("all configuration layers reject recursive delegation and pattern allowlists", (t) => {
	const f = fixture(t);
	for (const tool of ["subagent", "subagent_task", "*", "+read", "-bash", "subagent*"]) {
		const config: RunConfig = { tools: { allow: [tool] } };
		assert.throws(() => only({ task: "work", config }, f.environment()), /recursive|exact tool name/);
		assert.throws(() => only({ task: "work" }, f.environment({ defaults: config })), /recursive|exact tool name/);
		assert.throws(() => resolveRun({ tasks: [{ task: "work", config }] }, f.environment()), /recursive|exact tool name/);
		const agent: AgentConfig = { name: "bad", description: "bad", source: "user", filePath: path.join(f.user, "bad.md"), systemPrompt: "", config };
		assert.throws(() => only({ agent: "bad", task: "work", config: { tools: { allow: [] } } }, f.environment({ agents: [agent] })), /recursive|exact tool name/);
	}
});

test("readOnly is based on the entire resolved loadout, not role names or hints", (t) => {
	const f = fixture(t);
	for (const allow of [[], ["read"], ["read", "grep", "find", "ls"]]) {
		assert.equal(only({ task: "work", config: { tools: { allow } } }, f.environment()).readOnly, true);
	}
	for (const tools of [
		{ allow: ["read", "bash"] }, { allow: ["read", "edit"] }, { allow: ["write"] }, { allow: ["custom_read"] },
		{ allow: ["read"], extensions: ["./readonly.ts"] }, { allow: [], extensions: ["./plugin.ts"] },
		{ allow: ["read"], mcp: ["readonly_docs"] }, { allow: ["mcp__docs__read"] },
	]) {
		assert.equal(only({ task: "work", config: { tools } }, f.environment()).readOnly, false);
	}
});

test("resolution never mutates defaults, roles or requests; returned arrays are independent", (t) => {
	const f = fixture(t);
	f.role("user", "reader", "tools:\n  allow: [read]\n  extensions: [./plugin.ts]");
	const defaults: RunConfig = { tools: { allow: ["read", "ls"], mcp: ["docs"] }, rolePrompt: { append: "tail" } };
	const request: RunRequest = { tasks: [{ agent: "reader", task: "work", config: { tools: { mcp: [] } } }], config: { thinking: "low" } };
	const agents = f.discover().agents;
	const snapshot = JSON.stringify({ defaults, request, agents });
	const freeze = (value: unknown): void => {
		if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
	};
	freeze(defaults); freeze(request); freeze(agents);
	const result = resolveRun(request, f.environment({ defaults, agents }));
	result.tasks[0].tools.allow.push("ls");
	result.tasks[0].shadowedFiles.push("unrelated");
	assert.equal(JSON.stringify({ defaults, request, agents }), snapshot);
});

test("runtime validates configured defaults and the supplied model registry", (t) => {
	const f = fixture(t);
	assert.throws(() => only({ task: "work" }, f.environment({ defaults: { tools: { allow: null } } as never })), /array/);
	assert.throws(() => only({ task: "work" }, f.environment({ availableModels: ["bare-id"] })), /canonical/);
	assert.throws(() => only({ task: "work" }, f.environment({ availableModels: new Array(1) })), /canonical/);
	assert.throws(() => only({ task: "work" }, f.environment({ parentThinking: "invalid" as never })), /thinking/);
});

test("SubagentParams accepts every mode, inline tasks and all shared contract options", () => {
	assert.equal(SubagentParams.type, "object");
	for (const request of [
		{ task: "work" }, { agent: "user:reader", task: "work" },
		{ tasks: [{ task: "work", config: { tools: { allow: [] } } }], cwd: "." },
		{ chain: [{ task: "work" }, { task: "{previous}", agent: "project:reader" }], agentScope: "both" },
		{ task: "work", config: { model: "inherit", thinking: "max", systemPrompt: "", rolePrompt: { replace: "", append: "tail" }, tools: { allow: ["read"], extensions: [], mcp: [] } },
			background: true, notify: false, allowSharedWrites: true },
	]) assert.equal(Value.Check(SubagentParams, request), true, JSON.stringify(request));
});

test("SubagentParams is strict recursively and rejects malformed/conflicting mode keys", () => {
	// Undefined is not a JSON tool argument; runtime is intentionally stricter on its presence.
	const hasUndefined = (value: unknown): boolean => value === undefined ||
		(value !== null && typeof value === "object" && Object.values(value).some(hasUndefined));
	for (const request of badRequests.filter((value) => !hasUndefined(value))) {
		assert.equal(Value.Check(SubagentParams, request), false, JSON.stringify(request));
	}
	assert.equal(Value.Check(SubagentParams, { tasks: Array.from({ length: 9 }, () => ({ task: "work" })) }), false);
	assert.equal(Value.Check(SubagentParams, { chain: [{ task: "work", config: { tools: { allow: ["subagent"] } } }] }), false);
	assert.equal(Value.Check(RunConfigSchema, { tools: { allow: ["subagent_task"] } }), false);
});

test("TaskManagementParams has only list/status/result/cancel and enforces fields and numeric bounds", () => {
	assert.equal(TaskManagementParams.type, "object");
	assert.equal(Value.Check(TaskManagementParams, { action: "list" }), true);
	for (const action of ["status", "result", "cancel"]) {
		assert.equal(Value.Check(TaskManagementParams, { action, taskId: "task-1" }), true);
		assert.equal(Value.Check(TaskManagementParams, { action }), false);
	}
	assert.equal(Value.Check(TaskManagementParams, { action: "result", taskId: "task-1", cursor: 0, view: "log", maxBytes: 1024 }), true);
	assert.equal(Value.Check(TaskManagementParams, { action: "result", taskId: "task-1", view: "output" }), true);
	for (const value of [
		{ action: "usage" }, { action: "start", taskId: "one" }, { action: "list", unknown: true },
		{ action: "status", taskId: "" }, { action: "result", taskId: "one", view: "all" },
		{ action: "result", taskId: "one", cursor: -1 }, { action: "result", taskId: "one", cursor: 0.5 },
		{ action: "result", taskId: "one", maxBytes: 0 }, { action: "result", taskId: "one", maxBytes: 2.5 },
	]) assert.equal(Value.Check(TaskManagementParams, value), false, JSON.stringify(value));
});
