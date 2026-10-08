import * as os from "node:os";
import { getMarkdownTheme, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RunRequest, SingleResult, SubagentDetails, UsageStats } from "./contracts.ts";
import { resultFailed, resultOutput } from "./tasks.ts";
import { aggregateUsage } from "./process-runner.ts";

function tokens(count: number): string { return count < 1000 ? String(count) : count < 10000 ? `${(count / 1000).toFixed(1)}k` : count < 1000000 ? `${Math.round(count / 1000)}k` : `${(count / 1000000).toFixed(1)}M`; }
export function formatUsage(usage: Partial<UsageStats>, model?: string): string {
	return [usage.turns ? `${usage.turns} turns` : "", usage.input ? `↑${tokens(usage.input)}` : "", usage.output ? `↓${tokens(usage.output)}` : "",
		usage.cacheRead ? `R${tokens(usage.cacheRead)}` : "", usage.cacheWrite ? `W${tokens(usage.cacheWrite)}` : "", usage.cost ? `$${usage.cost.toFixed(4)}` : "",
		usage.contextTokens ? `ctx:${tokens(usage.contextTokens)}` : "", model ?? ""].filter(Boolean).join(" ");
}
function toolPreview(name: string, args: Record<string, unknown>): string {
	const shorten = (value: unknown) => String(value ?? "...").replace(os.homedir(), "~");
	if (name === "bash") return `$ ${String(args.command ?? "...").slice(0, 100)}`;
	if (["read", "write", "edit", "ls"].includes(name)) return `${name} ${shorten(args.path ?? args.file_path)}${name === "read" && args.offset ? `:${args.offset}` : ""}`;
	if (name === "grep") return `grep /${args.pattern ?? ""}/ in ${shorten(args.path ?? ".")}`;
	if (name === "find") return `find ${args.pattern ?? "*"} in ${shorten(args.path ?? ".")}`;
	return `${name} ${JSON.stringify(args).slice(0, 100)}`;
}
function displayItems(result: SingleResult): string[] {
	return result.messages.flatMap((message) => message.role === "assistant" ? message.content.flatMap((part) =>
		part.type === "toolCall" ? [`→ ${toolPreview(part.name, part.arguments)}`] : part.type === "text" ? [part.text.split("\n").slice(0, 3).join("\n")] : []) : []);
}
function icon(result: SingleResult, theme: Theme): string {
	return ["queued", "running", "cancelling"].includes(result.state ?? "") ? theme.fg("warning", "⏳") : result.state === "skipped" ? theme.fg("muted", "–") : resultFailed(result) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}
export function renderCall(args: RunRequest, theme: Theme): Text {
	const mode = args.chain ? "chain" : args.tasks ? "parallel" : "single";
	const items = args.chain ?? args.tasks ?? [{ agent: args.agent, task: args.task ?? "..." }];
	let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", mode === "single" ? items[0].agent ?? "inline" : `${mode} (${items.length})`) + theme.fg("muted", ` [${args.agentScope ?? "user"}]${args.background ? " background" : ""}`);
	for (const [index, item] of items.slice(0, 3).entries()) text += `\n  ${mode === "chain" ? `${index + 1}. ` : ""}${mode !== "single" ? `${item.agent ?? "inline"}: ` : ""}${theme.fg("dim", item.task.replace(/\{previous\}/g, "").slice(0, 80))}`;
	if (items.length > 3) text += `\n  … +${items.length - 3}`;
	return new Text(text, 0, 0);
}
export function renderResult(result: AgentToolResult<SubagentDetails>, { expanded }: { expanded: boolean }, theme: Theme): Container | Text {
	const details = result.details;
	if (!details?.results.length) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
	const done = details.results.filter((item) => ["completed", "failed", "cancelled", "skipped"].includes(item.state ?? "")).length;
	const header = `${theme.fg("toolTitle", theme.bold(details.mode))} ${done}/${details.results.length}${details.taskId ? theme.fg("muted", ` ${details.taskId}`) : ""} ${details.state ?? ""}`;
	if (!expanded) {
		const lines = [header];
		for (const item of details.results) {
			lines.push(`${icon(item, theme)} ${theme.fg("accent", item.agent)} (${item.agentSource}) ${item.state ?? ""}`);
			if (item.errorMessage) lines.push(theme.fg("error", item.errorMessage.slice(0, 500)));
			else lines.push(theme.fg("toolOutput", displayItems(item).slice(-10).join("\n") || "(no output)"));
			lines.push(theme.fg("dim", formatUsage(item.usage, item.model)));
		}
		lines.push(theme.fg("dim", `Total: ${formatUsage(details.usage ?? aggregateUsage(details.results.map((r) => r.usage)))}`));
		lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
		return new Text(lines.join("\n"), 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	for (const item of details.results) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(`${icon(item, theme)} ${theme.fg("accent", item.agent)} (${item.agentSource})${item.step ? ` step ${item.step}` : ""}`, 0, 0));
		if (item.resolved?.agentFile) container.addChild(new Text(theme.fg("dim", `Role: ${item.resolved.agentFile}`), 0, 0));
		if (item.resolved?.shadowedFiles.length) container.addChild(new Text(theme.fg("warning", `Overrides: ${item.resolved.shadowedFiles.join(", ")}`), 0, 0));
		container.addChild(new Text(theme.fg("dim", `Task: ${item.task}`), 0, 0));
		for (const message of item.messages) if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") container.addChild(new Text(theme.fg("muted", `→ ${toolPreview(part.name, part.arguments)}`), 0, 0));
		if (item.errorMessage) container.addChild(new Text(theme.fg("error", item.errorMessage), 0, 0));
		const output = resultOutput(item);
		if (output) container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
		if (item.outputTruncated || item.logTruncated) container.addChild(new Text(theme.fg("warning", "Output/log reached storage cap; omitted bytes are not retained."), 0, 0));
		if (item.usageComplete === false) container.addChild(new Text(theme.fg("warning", "Usage includes reported values only; child ended without a complete summary."), 0, 0));
		container.addChild(new Text(theme.fg("dim", formatUsage(item.usage, item.model)), 0, 0));
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", `Total: ${formatUsage(details.usage ?? aggregateUsage(details.results.map((r) => r.usage)))}`), 0, 0));
	return container;
}
