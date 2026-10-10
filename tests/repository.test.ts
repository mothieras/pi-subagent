import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { test } from "node:test";
import { parseDocument } from "yaml";

async function yaml(file: string): Promise<any> {
	const document = parseDocument(await fs.readFile(file, "utf8"));
	assert.deepEqual(document.errors, [], `${file}: invalid YAML`);
	return document.toJS();
}

test("CI validates the baseline on hosted POSIX runners without elevated PR permissions", async () => {
	const workflow = await yaml(".github/workflows/ci.yml");
	assert.ok("pull_request" in workflow.on);
	assert.deepEqual(workflow.on.pull_request.types, ["opened", "synchronize", "reopened", "edited"]);
	assert.ok("workflow_dispatch" in workflow.on);
	assert.deepEqual(workflow.on.push.branches, ["master"]);
	assert.ok(!("pull_request_target" in workflow.on));
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.equal(workflow.concurrency["cancel-in-progress"], true);
	for (const job of Object.values(workflow.jobs) as any[]) {
		assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 15);
		assert.ok(!job.permissions || Object.values(job.permissions).every((value) => value === "read" || value === "none"));
		for (const step of job.steps) {
			if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f\d]{40}$/, "Pin Actions to full commit SHAs");
		}
	}
	const job = workflow.jobs.test;
	assert.deepEqual(job.strategy.matrix.os, ["ubuntu-latest", "macos-latest"]);
	assert.equal(job.strategy["fail-fast"], false);
	assert.equal(job.env.PI_OFFLINE, "1");
	const checkout = job.steps.find((step: any) => step.uses?.startsWith("actions/checkout@"));
	assert.equal(checkout.with["persist-credentials"], false);
	assert.equal(checkout.with["fetch-depth"], 2);
	const setup = job.steps.find((step: any) => step.uses?.startsWith("actions/setup-node@"));
	assert.equal(setup.with["node-version"], "24");
	assert.equal(setup.with.cache, "npm");
	assert.equal(setup.with["cache-dependency-path"], "package-lock.json");
	const commands = job.steps.map((step: any) => step.run).filter(Boolean);
	for (const command of ["npm ci --ignore-scripts", "npm run check", "npm test", "git diff --check HEAD^ HEAD"]) assert.ok(commands.includes(command), command);
	assert.ok(commands.some((command: string) => command.includes("git status --porcelain") && command.includes("exit 1")));
	assert.ok(commands.some((command: string) => command.includes("PI_CODING_AGENT_DIR=$RUNNER_TEMP/") && command.includes('>> "$GITHUB_ENV"')));
	assert.doesNotMatch(await fs.readFile(".github/workflows/ci.yml", "utf8"), /secrets\.|self-hosted|pull_request_target/);
});

test("dependency maintenance covers weekly Actions/npm updates and groups host API packages", async () => {
	const config = await yaml(".github/dependabot.yml");
	assert.equal(config.version, 2);
	assert.deepEqual(config.updates.map((update: any) => update["package-ecosystem"]).sort(), ["github-actions", "npm"]);
	for (const update of config.updates) {
		assert.equal(update.directory, "/");
		assert.equal(update.schedule.interval, "weekly");
		assert.ok(update["open-pull-requests-limit"] > 0 && update["open-pull-requests-limit"] <= 3);
	}
	assert.deepEqual(config.updates.find((update: any) => update["package-ecosystem"] === "npm").groups["pi-host"].patterns, ["@earendil-works/pi-*"]);
});

test("issue forms have unique fields, required reproducible input and privacy guidance", async () => {
	for (const name of ["bug_report", "feature_request"]) {
		const form = await yaml(`.github/ISSUE_TEMPLATE/${name}.yml`);
		assert.equal(typeof form.name, "string");
		assert.equal(typeof form.description, "string");
		assert.ok(form.body.length > 0);
		const inputs = form.body.filter((field: any) => field.type !== "markdown");
		assert.equal(new Set(inputs.map((field: any) => field.id)).size, inputs.length);
		assert.ok(inputs.every((field: any) => field.id && field.attributes.label));
		assert.ok(inputs.filter((field: any) => field.validations?.required).length >= 3);
		const guidance = form.body.filter((field: any) => field.type === "markdown").map((field: any) => field.attributes.value).join("\n");
		assert.match(guidance, /credentials/i);
		assert.match(guidance, /private prompts\/reports/);
		if (name === "bug_report") assert.match(guidance, /SECURITY\.md/);
	}
	assert.equal((await yaml(".github/ISSUE_TEMPLATE/config.yml")).blank_issues_enabled, true);
});

test("changelog covers the current release and unreleased work without changing publication policy", async () => {
	const manifest = JSON.parse(await fs.readFile("package.json", "utf8"));
	const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages[""].version, manifest.version);
	const changelog = await fs.readFile("CHANGELOG.md", "utf8");
	assert.ok(changelog.includes("## [Unreleased]"));
	assert.ok(changelog.includes(`## [${manifest.version}] - `));
	assert.ok(changelog.indexOf("## [Unreleased]") < changelog.indexOf(`## [${manifest.version}]`));
	assert.equal(manifest.private, true);
	assert.ok(Object.values(manifest.peerDependencies).every((range) => range === "*"));
});
