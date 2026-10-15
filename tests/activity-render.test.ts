import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeybindingsManager as AppKeys, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { emptyUsage, type TaskSummary } from "../contracts.ts";
import { ActivityView, formatActivity, formatDuration, renderResult } from "../render.ts";

const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`, bold: (text: string) => text } as Theme;
const keys = (bindings = {}) => new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "ctrl+c" } }, bindings) as AppKeys;
const summary = (overrides: Partial<TaskSummary> = {}): TaskSummary => ({ taskId: "group-id", state: "running", mode: "parallel", startedAt: 1000,
	expired: false, resultDelivered: false, progress: { total: 2, done: 0 }, usage: emptyUsage(), results: [
		{ itemId: "group-id/1", agent: "鲨鱼🌍", state: "running", startedAt: 2000, elapsedMs: 1234, currentTool: "read", lastEventAt: 3000 },
		{ itemId: "group-id/2", agent: "inline", state: "queued" },
	], ...overrides });

test("activity formatting separates waiting, elapsed runtime, tool execution and event age", () => {
	assert.equal(formatActivity({ agent: "inline", state: "queued" }), "queued · not started");
	assert.equal(formatActivity({ agent: "inline", state: "running", elapsedMs: 1250, currentTool: "read", lastEventAt: 1000 }, 4000), "running · 1s · tool: read · event 3s ago");
	assert.deepEqual([0, 999, 1000, 61000, 3661000, -100].map(formatDuration), ["0s", "0s", "1s", "1m 1s", "1h 1m", "0s"]);
});
test("activity view fits narrow terminals and resizes with wide text and ANSI theme styling", () => {
	let rows = 30;
	const view = new ActivityView(() => ({ tasks: [summary()], usage: emptyUsage() }), theme, keys(), () => rows, () => {}, () => {});
	for (const width of [1, 12, 32, 80, 120]) {
		for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
	}
	assert.match(view.render(32).join("\n"), /tool: read/, "Narrow layout keeps the tool visible on its own activity line");
	const wide = view.render(120).join("\n");
	assert.match(wide, /1\. 鲨鱼🌍/); assert.match(wide, /2\. inline · queued · not started/); assert.match(wide, /tool: read/);
	assert.match(wide, /started 1970-/); assert.match(wide, /not proof of process health/);
	rows = 10;
	assert.ok(view.render(60).length <= rows);
	view.invalidate();
	assert.ok(view.render(60).length <= rows);
});
test("activity paging fits the 90-percent overlay budget, not just the terminal", () => {
	let rows = 30;
	const tasks = Array.from({ length: 10 }, (_, index) => summary({ taskId: `group-${index}` }));
	const view = new ActivityView(() => ({ tasks, usage: emptyUsage() }), theme, keys(), () => Math.floor(rows * 0.9), () => {}, () => {});
	for (rows of [10, 12, 20, 30, 40]) {
		const lines = view.render(100);
		assert.ok(lines.length <= Math.floor(rows * 0.9), `Overlay clips at ${rows} terminal rows`);
		assert.match(lines.at(-1)!, /close/);
	}
});
test("activity view has an empty state, bounded paging and configurable close keys", () => {
	let tasks: TaskSummary[] = []; let closed = 0; let requests = 0;
	const view = new ActivityView(() => ({ tasks, usage: emptyUsage() }), theme, keys({ "tui.select.cancel": "ctrl+q", "tui.select.down": "j" }),
		() => 12, () => { requests++; }, () => { closed++; });
	assert.match(view.render(100).join("\n"), /No subagent tasks/);
	tasks = Array.from({ length: 20 }, (_, index) => summary({ taskId: `group-${index}` }));
	view.render(100);
	for (let i = 0; i < 500; i++) view.handleInput("j");
	const end = view.render(100).join("\n");
	view.handleInput("j"); assert.equal(view.render(100).join("\n"), end);
	view.handleInput("\u001b[5~"); assert.notEqual(view.render(100).join("\n"), end);
	assert.match(view.render(100).join("\n"), /ctrl\+q: close/);
	view.handleInput("\u0011"); assert.equal(closed, 1);
	const before = requests; view.refresh(); view.close(); assert.equal(requests, before); assert.equal(closed, 1);
});
test("activity view shows active groups first and sanitizes untrusted labels without task reports", () => {
	const tasks = [summary({ taskId: "done", state: "completed", startedAt: 5000 }), summary({ taskId: "active", startedAt: 1000,
		results: [{ agent: "bad\n\x1b[2Jlabel", state: "running", currentTool: "tool\x1b]52;c;secret\x07", elapsedMs: 0 }] })];
	const view = new ActivityView(() => ({ tasks, usage: emptyUsage() }), theme, keys(), () => 30, () => {}, () => {});
	const rendered = view.render(150).join("\n");
	assert.ok(rendered.indexOf("active") < rendered.indexOf("done"));
	assert.ok(!rendered.includes("\x1b[2J")); assert.ok(!rendered.includes("\x1b]52")); assert.ok(!rendered.includes("\x07"));
});
test("tool result rendering includes live activity in collapsed and expanded views", () => {
	const result = { content: [], details: { mode: "single" as const, agentScope: "user" as const, projectAgentsDir: null,
		results: [{ agent: "inline", agentSource: "inline" as const, task: "test", state: "running" as const, exitCode: -1,
			messages: [], stderr: "", usage: emptyUsage(), elapsedMs: 2500, currentTool: "read", lastEventAt: Date.now() }] } };
	for (const expanded of [false, true]) {
		const lines = renderResult(result, { expanded }, theme).render(120).join("\n");
		assert.match(lines, /running · 2s · tool: read/);
	}
});
