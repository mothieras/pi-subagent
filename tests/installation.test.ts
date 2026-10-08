import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("native conventional directory symlinks load exactly one subagent, task manager and Plan Mode", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-installation-test-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent"); const extensions = path.join(agentDir, "extensions");
	await fs.mkdir(extensions, { recursive: true });
	await fs.symlink(path.resolve("."), path.join(extensions, "subagent"), "dir");
	await fs.symlink(path.resolve("compat/plan-mode"), path.join(extensions, "plan-mode"), "dir");
	const loaded = await discoverAndLoadExtensions([], root, agentDir);
	assert.deepEqual(loaded.errors, []);
	const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
	const commands = loaded.extensions.flatMap((extension) => [...extension.commands.keys()]);
	for (const name of ["subagent", "subagent_task"]) assert.equal(tools.filter((tool) => tool === name).length, 1);
	assert.equal(commands.filter((command) => command === "plan").length, 1);
});
