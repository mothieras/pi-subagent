import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { DefaultPackageManager, formatSkillsForPrompt, loadSkills, loadSkillsFromDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { resolveRun } from "../config.ts";
import type { RunRequest } from "../contracts.ts";
import { SubagentParams } from "../schemas.ts";

const skillDir = path.resolve("skills/pi-subagent");
async function fixture(t: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-test-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	return { root, agentDir };
}

test("conventional skill directory symlinks advertise the guide without loading its body", async (t) => {
	const { agentDir } = await fixture(t);
	const skillsDir = path.join(agentDir, "skills");
	await fs.mkdir(skillsDir);
	await fs.symlink(skillDir, path.join(skillsDir, "pi-subagent"), "dir");
	const loaded = loadSkillsFromDir({ dir: skillsDir, source: "user" });
	assert.deepEqual(loaded.diagnostics, []);
	assert.equal(loaded.skills.length, 1);
	const skill = loaded.skills[0];
	assert.equal(skill.name, "pi-subagent");
	assert.equal(skill.disableModelInvocation, false);
	assert.match(skill.description, /subagent\/subagent_task/);
	const body = await fs.readFile(skill.filePath, "utf8");
	assert.match(body, /^# Delegation guide$/m);
	assert.ok(body.split("\n").length <= 100, "Keep the guide short");
	const prompt = formatSkillsForPrompt(loaded.skills);
	assert.ok(prompt.replaceAll("&apos;", "'").includes(skill.description));
	assert.ok(prompt.includes(skill.filePath));
	assert.ok(!prompt.includes("# Delegation guide"), "Only metadata belongs in the initial prompt");
});

test("package manifest exposes the guide alongside tools and prompts, with optional skill filtering", async (t) => {
	const { root, agentDir } = await fixture(t);
	for (const filtered of [false, true]) {
		const source = path.resolve(".");
		const settingsManager = SettingsManager.inMemory({ packages: [filtered ? { source, skills: [] } : source] });
		const manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager });
		const resources = await manager.resolve();
		const enabled = (type: "extensions" | "skills" | "prompts") => resources[type].filter((resource) => resource.enabled && resource.metadata.origin === "package").map((resource) => resource.path);
		assert.deepEqual(enabled("extensions"), [path.resolve("index.ts")]);
		assert.deepEqual(enabled("prompts").sort(), ["implement", "implement-and-review", "scout-and-plan"].map((name) => path.resolve(`prompts/${name}.md`)).sort());
		const loaded = loadSkills({ cwd: root, agentDir, skillPaths: enabled("skills"), includeDefaults: false });
		assert.deepEqual(loaded.diagnostics, []);
		assert.deepEqual(loaded.skills.map((skill) => skill.name), filtered ? [] : ["pi-subagent"]);
	}
});

test("guide examples satisfy the tool schema and clear writable/external user defaults", async () => {
	const body = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
	const examples = [...body.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]) as RunRequest);
	assert.ok(examples.length > 0, "Keep at least one complete call example");
	for (const request of examples) {
		assert.equal(Value.Check(SubagentParams, request), true, JSON.stringify(request));
		const run = resolveRun(request, {
			cwd: path.resolve("."), parentModel: "fake/test", parentThinking: "high", agents: [], projectAgentsDir: null,
			availableModels: ["fake/test"], defaults: { tools: { allow: ["bash", "edit", "write"], extensions: ["./default-tools.ts"], mcp: ["default_server"] } },
		});
		assert.equal(run.background, true);
		assert.equal(run.tasks[0].agentSource, "inline");
		assert.equal(run.tasks[0].readOnly, true);
		assert.deepEqual(run.tasks[0].tools, { allow: ["read", "grep", "find", "ls"], extensions: [], mcp: [] });
	}
});
