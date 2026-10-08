import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { SubagentParams, TaskManagementParams } from "../schemas.ts";

async function markdownFiles(directory: string): Promise<string[]> {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(entries.map((entry) => {
		const file = path.join(directory, entry.name);
		return entry.isDirectory() ? markdownFiles(file) : Promise.resolve(entry.name.endsWith(".md") ? [file] : []);
	}));
	return nested.flat();
}

test("public Markdown relative links resolve after the documentation reorganization", async () => {
	const documents = ["README.md", "INSTALL.md", "AGENTS.md", ...(await Promise.all(["docs", "skills", "agents", "prompts"].map(markdownFiles))).flat()];
	for (const document of documents) {
		const body = await fs.readFile(document, "utf8");
		for (const match of body.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
			const target = match[1].split("#")[0];
			if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
			const resolved = path.resolve(path.dirname(document), decodeURIComponent(target));
			await assert.doesNotReject(fs.access(resolved), `${document}: broken link to ${target}`);
		}
	}
});

test("README, API, and skill JSON calls match the public tool schemas", async () => {
	for (const document of ["README.md", "docs/API.md", "skills/pi-subagent/SKILL.md"]) {
		const body = await fs.readFile(document, "utf8");
		let calls = 0;
		for (const match of body.matchAll(/```json\n([\s\S]*?)\n```/g)) {
			const example = JSON.parse(match[1]);
			if ("task" in example || "tasks" in example || "chain" in example) {
				assert.equal(Value.Check(SubagentParams, example), true, `${document}: ${JSON.stringify(example)}`);
				calls++;
			} else if ("action" in example) {
				assert.equal(Value.Check(TaskManagementParams, example), true, `${document}: ${JSON.stringify(example)}`);
				calls++;
			}
		}
		assert.ok(calls > 0, `${document}: include a complete tool call`);
	}
});
