import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import type { Readable } from "node:stream";
import { emptyUsage, type RunChild, type SingleResult, type UsageStats } from "./contracts.ts";

export interface ProcessRunnerOptions {
	invocation?: (args: string[]) => { command: string; args: string[] };
	childExtensionPath?: string;
	killGraceMs?: number;
	/** Coalesce text-delta UI snapshots; accounting always consumes every record. */
	updateIntervalMs?: number;
	maxLogBytes?: number;
	maxOutputBytes?: number;
	/** Maximum JSONL record size AND total retained display-message size. */
	maxMessageBytes?: number;
}

/** Follow Pi's subprocess example, including compiled/Bun executable support. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	if (!/^(node|bun)(\.exe)?$/.test(path.basename(process.execPath).toLowerCase())) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

type ObjectValue = Record<string, any>;
function object(value: unknown): value is ObjectValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
const counters = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens", "cost", "turns"] as const;
const costCounters = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Normalize provider Usage (whose cost is an object) or our flattened UsageStats. */
export function normalizeUsage(value: unknown): UsageStats {
	const usage = emptyUsage();
	if (!object(value)) return usage;
	for (const key of counters) usage[key] = number(value[key]);
	if (value.totalTokens === undefined) usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	usage.contextTokens = number(value.contextTokens);
	const cost = object(value.cost) ? value.cost : value.costBreakdown;
	if (object(cost)) {
		for (const key of costCounters) usage.costBreakdown[key] = number(cost[key]);
		if (object(value.cost)) usage.cost = number(cost.total);
	}
	return usage;
}

/** Context is a latest-value gauge; reasoning and cacheWrite1h are already subsets. */
export function aggregateUsage(usages: readonly UsageStats[]): UsageStats {
	const total = emptyUsage();
	for (const usage of usages) {
		for (const key of counters) total[key] += usage[key];
		for (const key of costCounters) total.costBreakdown[key] += usage.costBreakdown[key];
		total.contextTokens = usage.contextTokens;
	}
	return total;
}

export function getFinalOutput(messages: readonly SingleResult["messages"][number][]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		}
	}
	return "";
}

function prefix(text: string, bytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= bytes) return text;
	let end = bytes;
	// Never leave a partial UTF-8 code point in a display string or output file.
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}
function limit(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function validSummary(value: unknown): value is UsageStats {
	return object(value) && [...counters, "contextTokens"].every((key) =>
		typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0,
	) && object(value.costBreakdown) && costCounters.every((key) =>
		typeof value.costBreakdown[key] === "number" && Number.isFinite(value.costBreakdown[key]) && value.costBreakdown[key] >= 0,
	);
}
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function createProcessRunner(options: ProcessRunnerOptions = {}): RunChild {
	const invocation = options.invocation ?? getPiInvocation;
	const childExtensionPath = options.childExtensionPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "child.ts");
	const grace = Math.min(limit(options.killGraceMs, 1000), 30_000);
	const updateInterval = Math.min(limit(options.updateIntervalMs, 100), 1000);
	const logLimit = limit(options.maxLogBytes, 4 * 1024 * 1024);
	const outputLimit = limit(options.maxOutputBytes, 256 * 1024);
	const messageLimit = limit(options.maxMessageBytes, 1024 * 1024);

	return async (task, files, signal, onUpdate) => {
		const result: SingleResult = {
			agent: task.agent, agentSource: task.agentSource, task: task.task, resolved: task,
			exitCode: -1, state: "running", messages: [], stderr: "", usage: emptyUsage(),
			usageComplete: false, output: "", outputTruncated: false, logTruncated: false,
		};
		let cancelled = signal.aborted;
		let failure: string | undefined;
		let protocolLost = false;
		let hardKilled = false;
		let ready = false;
		let callbackBroken = false;
		let logFd: number | undefined;
		let outputFd: number | undefined;
		let logBytes = 0;
		let proc: ChildProcess | undefined;
		let exited = false;
		let closed = false;
		let terminating = false;
		let treeDone = true;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let updateTimer: ReturnType<typeof setTimeout> | undefined;
		let lastUpdate = 0;
		let settle: (() => void) | undefined;
		let committedUsage = emptyUsage();
		let partialUsage: UsageStats | undefined;
		let partial: ObjectValue | undefined;
		let displayBytes = 2; // JSON array brackets; each retained message also reserves a comma.
		const displays: Array<{ message: SingleResult["messages"][number]; bytes: number }> = [];
		// Fixed-size identities, not retained full messages. Fail closed rather than lose deduplication.
		const seen = new Set<string>();
		const stdoutDecoder = new StringDecoder("utf8");
		const stdoutValidator = new TextDecoder("utf-8", { fatal: true });
		const stderrDecoder = new StringDecoder("utf8");
		let record = "";
		let recordBytes = 0;
		let stdoutEnded = false;
		let privateSummary: { usage: UsageStats; complete: boolean } | undefined;
		let control: Readable | undefined;
		const descendants = new Set<number>();
		const descendantGroups = new Set<number>();
		const captureDescendants = () => {
			if (!proc?.pid || process.platform === "win32") return;
			const listing = spawnSync("ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024 });
			const rows = (listing.stdout ?? "").split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 3 && row.every(Number.isSafeInteger));
			const family = new Set([proc.pid, ...descendants]);
			let changed = true;
			while (changed) {
				changed = false;
				for (const [pid, parent] of rows) if (family.has(parent) && !family.has(pid)) { family.add(pid); descendants.add(pid); changed = true; }
			}
			for (const [pid, , group] of rows) if (family.has(pid) && family.has(group)) descendantGroups.add(group);
		};

		const fail = (message: string, loss = false) => {
			failure ??= prefix(message, 16 * 1024);
			protocolLost ||= loss;
			terminate();
		};
		const writeLog = (data: Buffer) => {
			const allowed = Math.min(data.length, Math.max(0, logLimit - logBytes));
			if (allowed < data.length) result.logTruncated = true;
			if (logFd === undefined || allowed === 0) return;
			try {
				// Synchronous, bounded writes avoid an unbounded write-stream queue behind noisy children.
				let offset = 0;
				while (offset < allowed) offset += fs.writeSync(logFd, data, offset, allowed - offset);
				logBytes += allowed;
			} catch (error) {
				fail(`Cannot write child log: ${errorText(error)}`);
			}
		};
		const stderr = (text: string) => { result.stderr += prefix(text, Math.max(0, logLimit - Buffer.byteLength(result.stderr))); };
		const treeAlive = () => {
			if (!proc?.pid) return false;
			if (process.platform === "win32") return !exited;
			for (const pid of [-proc.pid, ...descendants]) {
				try { process.kill(pid, 0); return true; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true; }
			}
			return false;
		};
		const killTree = (force: boolean) => {
			if (!proc?.pid) return;
			try {
				if (process.platform === "win32") {
					const killed = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", ...(force ? ["/F"] : [])], {
						shell: false, windowsHide: true, stdio: "ignore", timeout: 1000,
					});
					if (killed.error || killed.status !== 0) proc.kill(force ? "SIGKILL" : "SIGTERM");
				} else {
					// Pi's shell and stdio MCP children can own detached process groups. Capture
					// them while their parent still exists; killing only the CLI group misses them.
					for (const pid of new Set([-proc.pid, ...[...descendantGroups].map((group) => -group), ...descendants])) {
						try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); }
						catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
					failure ??= prefix(`Cannot terminate child process group: ${errorText(error)}`, 16 * 1024);
				}
			}
		};
		const maybeSettle = () => {
			if (closed && terminating && !treeAlive()) {
				if (graceTimer) clearTimeout(graceTimer);
				graceTimer = undefined;
				treeDone = true;
			}
			if (closed && treeDone) settle?.();
		};
		function terminate() {
			if (!proc?.pid || terminating) return;
			terminating = true;
			treeDone = false;
			captureDescendants();
			killTree(false);
			graceTimer = setTimeout(() => {
				graceTimer = undefined;
				// ChildProcess.killed means a signal was SENT, not that the process exited.
				captureDescendants();
				if (treeAlive()) { hardKilled = true; killTree(true); }
				treeDone = true;
				if (!closed) {
					// A broken/escaped pipe holder must not keep cancellation pending forever.
					drainTimer = setTimeout(() => {
						protocolLost = true;
						failure ??= "Child pipes did not close after termination";
						proc?.stdout?.destroy();
						proc?.stderr?.destroy();
						control?.destroy();
						closed = true;
						maybeSettle();
					}, 1000);
				}
				maybeSettle();
			}, grace);
			maybeSettle();
		}
		const snapshot = (): SingleResult => {
			const usage = partialUsage ? aggregateUsage([committedUsage, partialUsage]) : normalizeUsage(committedUsage);
			if (partialUsage) usage.contextTokens = partialUsage.totalTokens || committedUsage.contextTokens;
			let messages = displays.map((display) => display.message);
			if (partial) {
				const bytes = Buffer.byteLength(JSON.stringify(partial)) + 1;
				if (bytes + 2 <= messageLimit) {
					let total = displayBytes + bytes;
					while (messages.length && total > messageLimit) total -= Buffer.byteLength(JSON.stringify(messages.shift())) + 1;
					messages = [...messages, partial as SingleResult["messages"][number]];
				}
			}
			return structuredClone({ ...result, messages, usage });
		};
		const emit = (force = true) => {
			if (callbackBroken) return;
			if (!force && updateInterval > 0 && Date.now() - lastUpdate < updateInterval) {
				updateTimer ??= setTimeout(() => { updateTimer = undefined; emit(true); }, updateInterval - (Date.now() - lastUpdate));
				return;
			}
			if (updateTimer) { clearTimeout(updateTimer); updateTimer = undefined; }
			lastUpdate = Date.now();
			try {
				const returned: unknown = onUpdate(snapshot());
				// Defend against accidentally async callbacks as well as synchronous throws.
				if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
					Promise.resolve(returned).catch((error) => {
						callbackBroken = true;
						if (!closed) fail(`Child update callback failed: ${errorText(error)}`);
					});
				}
			} catch (error) {
				callbackBroken = true;
				fail(`Child update callback failed: ${errorText(error)}`);
			}
		};
		const abort = () => {
			cancelled = true;
			result.state = "cancelling";
			terminate();
		};
		const remember = (key: string) => {
			if (seen.has(key)) return false;
			if (seen.size >= 65_536) { fail("Too many child accounting identities", true); return false; }
			seen.add(key);
			return true;
		};
		const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
		const addUsage = (usage: unknown, assistant = false) => {
			const normalized = normalizeUsage(usage);
			normalized.turns = assistant ? 1 : 0;
			normalized.contextTokens = assistant ? normalized.totalTokens : committedUsage.contextTokens;
			committedUsage = aggregateUsage([committedUsage, normalized]);
			result.usageComplete = false;
		};
		const display = (message: ObjectValue) => {
			const bytes = Buffer.byteLength(JSON.stringify(message)) + 1;
			if (bytes + 2 > messageLimit) return;
			while (displays.length && (displayBytes + bytes > messageLimit || displays.length >= 256)) {
				displayBytes -= displays.shift()!.bytes;
			}
			displays.push({ message: message as SingleResult["messages"][number], bytes });
			displayBytes += bytes;
		};
		const saveOutput = (message: ObjectValue) => {
			const text = getFinalOutput([message as SingleResult["messages"][number]]);
			result.output = prefix(text, outputLimit);
			result.outputTruncated = Buffer.byteLength(text) > outputLimit;
			try {
				if (outputFd !== undefined) {
					fs.ftruncateSync(outputFd, 0);
					const data = Buffer.from(result.output);
					let offset = 0;
					while (offset < data.length) offset += fs.writeSync(outputFd, data, offset, data.length - offset, offset);
				}
			} catch (error) { fail(`Cannot write child output: ${errorText(error)}`); }
		};
		const processRecord = (line: string, privateChannel = false) => {
			let event: ObjectValue;
			try {
				const parsed: unknown = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
				if (!object(parsed) || typeof parsed.type !== "string") throw new Error("expected event object with type");
				event = parsed;
			} catch (error) { fail(`Invalid child JSONL: ${errorText(error)}`, true); return; }
			if (event.type === "subagent_error") {
				fail(typeof event.error === "string" ? `Subagent configuration error: ${event.error}` : "Child bootstrap failed", true);
				return;
			}
			if (event.type === "subagent_ready") {
				if (typeof event.model !== "string" || !thinkingLevels.has(event.thinking) ||
					!Array.isArray(event.tools) || !event.tools.every((tool: unknown) => typeof tool === "string")) {
					fail("Invalid subagent_ready metadata", true); return;
				}
				result.model = event.model;
				result.thinking = event.thinking;
				result.resolved = { ...task, model: event.model, thinking: event.thinking, tools: { ...task.tools, allow: event.tools } };
				if (event.model !== task.model) { fail(`Child model mismatch: expected ${task.model}, got ${event.model}`, true); return; }
				if (event.tools.length !== new Set(task.tools.allow).size || event.tools.some((name: string) => !task.tools.allow.includes(name))) {
					fail("Child tool allowlist mismatch", true); return;
				}
				ready = true;
			} else if (event.type === "subagent_usage") {
				if (!validSummary(event.usage) || typeof event.complete !== "boolean") {
					fail("Invalid subagent_usage summary", true); return;
				}
				// Pipes are independent: an FD3 summary can arrive before buffered stdout messages.
				// Keep it authoritative at close rather than add late-arriving message_end twice.
				if (privateChannel) privateSummary = { usage: normalizeUsage(event.usage), complete: event.complete };
				else {
					committedUsage = normalizeUsage(event.usage);
					partialUsage = undefined;
					result.usageComplete = event.complete;
				}
			} else if (event.type === "message_start" && event.message?.role === "assistant") {
				partialUsage = undefined;
				partial = { role: "assistant", content: [], model: result.model ?? task.model, provider: "", api: "",
					stopReason: "pending", timestamp: number(event.message.timestamp), usage: normalizeUsage(undefined) };
			} else if (event.type === "message_update") {
				partialUsage = normalizeUsage(event.usage);
				partialUsage.turns = 1;
				if (partial) partial.usage = { ...partialUsage, cost: { ...partialUsage.costBreakdown, total: partialUsage.cost } };
				result.usageComplete = false;
				const update = event.assistantMessageEvent;
				if (partial && object(update) && Number.isInteger(update.contentIndex) && update.contentIndex >= 0 && update.contentIndex < 256) {
					const index = update.contentIndex;
					if ((update.type === "text_delta" && typeof update.delta === "string") || (update.type === "text_end" && typeof update.content === "string")) {
						while (partial.content.length <= index) partial.content.push({ type: "text", text: "" });
						const previous = partial.content[index].text;
						partial.content[index] = { type: "text", text: prefix(update.type === "text_end" ? update.content : previous + update.delta, messageLimit) };
						if (Buffer.byteLength(JSON.stringify(partial)) > messageLimit) partial = undefined;
					}
				}
			} else if (event.type === "message_end") {
				const message = event.message;
				if (!object(message) || typeof message.role !== "string") { fail("Invalid message_end", true); return; }
				if (message.role !== "assistant" && message.role !== "toolResult") return;
				if (!Array.isArray(message.content) || !message.content.every((part: unknown) => object(part) &&
					(part.type !== "text" || typeof part.text === "string"))) { fail("Invalid message content", true); return; }
				const identity = message.role === "toolResult" && typeof message.toolCallId === "string" ? message.toolCallId :
					typeof message.responseId === "string" ? message.responseId : hash(message);
				if (!remember(`${message.role}:${identity}`)) return;
				addUsage(message.usage, message.role === "assistant");
				if (message.role === "assistant") {
					partialUsage = undefined;
					partial = undefined;
					result.stopReason = typeof message.stopReason === "string" ? prefix(message.stopReason, 128) : undefined;
					result.errorMessage = typeof message.errorMessage === "string" ? prefix(message.errorMessage, 16 * 1024) : undefined;
					saveOutput(message);
				}
				display(message);
			} else if (event.type === "compaction_end" && object(event.result) && event.result.usage) {
				const compact = event.result;
				if (remember(`compaction:${hash([compact.summary, compact.firstKeptEntryId, compact.usage])}`)) addUsage(compact.usage);
			} else if (event.type === "entry_appended" && object(event.entry)) {
				const entry = event.entry;
				if (["usage", "branch_summary", "compaction"].includes(entry.type) && entry.usage) {
					const identity = entry.type === "compaction" ? hash([entry.summary, entry.firstKeptEntryId, entry.usage]) : entry.id ?? hash(entry);
					if (remember(`${entry.type}:${identity}`)) addUsage(entry.usage);
				}
			} else if (event.type === "auto_retry_end" && event.success === false) {
				result.stopReason = "error";
				result.errorMessage = prefix(typeof event.finalError === "string" ? event.finalError : "Child retries exhausted", 16 * 1024);
			} else if (event.type === "agent_settled" && event.aborted === true) {
				result.stopReason = "aborted";
			}
			emit(event.type !== "message_update");
		};
		const stdout = (chunk: Buffer) => {
			writeLog(chunk);
			if (protocolLost) return; // Still drain the pipe after a protocol failure.
			let start = 0;
			while (start < chunk.length && !protocolLost) {
				const lf = chunk.indexOf(10, start);
				const end = lf < 0 ? chunk.length : lf + 1;
				const segment = chunk.subarray(start, end);
				recordBytes += segment.length - (lf < 0 ? 0 : 1);
				if (recordBytes > messageLimit) { record = ""; fail("Child JSONL record exceeds maxMessageBytes", true); return; }
				try { stdoutValidator.decode(segment, { stream: true }); }
				catch { record = ""; fail("Child stdout is not valid UTF-8", true); return; }
				record += stdoutDecoder.write(segment);
				if (lf >= 0) {
					try { processRecord(record.slice(0, -1)); }
					catch (error) { fail(`Cannot process child JSONL: ${errorText(error)}`, true); }
					record = "";
					recordBytes = 0;
				}
				start = end;
			}
		};
		const endStdout = () => {
			if (stdoutEnded) return;
			stdoutEnded = true;
			if (protocolLost) return;
			try { stdoutValidator.decode(); stdoutDecoder.end(); }
			catch { fail("Child stdout ended with invalid UTF-8", true); return; }
			if (recordBytes) fail("Child stdout ended with an unterminated JSONL record", true);
		};

		const controlDecoder = new StringDecoder("utf8");
		const controlValidator = new TextDecoder("utf-8", { fatal: true });
		let controlRecord = "";
		let controlBytes = 0;
		const controlData = (chunk: Buffer) => {
			writeLog(chunk);
			if (protocolLost) return;
			let start = 0;
			while (start < chunk.length && !protocolLost) {
				const lf = chunk.indexOf(10, start);
				const end = lf < 0 ? chunk.length : lf + 1;
				const segment = chunk.subarray(start, end);
				controlBytes += segment.length - (lf < 0 ? 0 : 1);
				if (controlBytes > messageLimit) { fail("Child control record exceeds maxMessageBytes", true); return; }
				try { controlValidator.decode(segment, { stream: true }); }
				catch { fail("Child control pipe is not valid UTF-8", true); return; }
				controlRecord += controlDecoder.write(segment);
				if (lf >= 0) {
					try { processRecord(controlRecord.slice(0, -1), true); }
					catch (error) { fail(`Cannot process child control JSONL: ${errorText(error)}`, true); }
					controlRecord = ""; controlBytes = 0;
				}
				start = end;
			}
		};

		try {
			if (cancelled) { result.state = "cancelled"; result.exitCode = 1; return result; }
			logFd = fs.openSync(files.logPath, "w", 0o600);
			outputFd = fs.openSync(files.outputPath, "w", 0o600);
			const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-mcp", "--no-skills",
				"--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline",
				...task.tools.extensions.flatMap((extension) => ["-e", extension]),
				"-e", childExtensionPath, "--model", task.model, "--thinking", task.thinking,
				...(task.tools.allow.length ? ["--tools", task.tools.allow.join(",")] : ["--no-tools"]), "--", `Task: ${task.task}`];
			const command = invocation(args);
			// An injected invocation can synchronously abort; never launch in that case either.
			if (signal.aborted) { cancelled = true; result.exitCode = 1; }
			else {
				proc = spawn(command.command, command.args, {
					cwd: task.cwd, shell: false, stdio: ["ignore", "pipe", "pipe", "pipe"],
					detached: process.platform !== "win32", windowsHide: true,
					env: { ...process.env, PI_SUBAGENT_CONFIG: files.configPath, PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PROTOCOL_FD: "3" },
				});
				await new Promise<void>((resolve) => {
					settle = resolve;
					control = proc!.stdio[3] as Readable;
					control.on("data", controlData);
					control.on("error", (error) => fail(`Child control pipe error: ${errorText(error)}`, true));
					control.on("end", () => {
						if (protocolLost) return;
						try { controlValidator.decode(); controlDecoder.end(); } catch { fail("Invalid UTF-8 in child control pipe", true); }
						if (controlBytes) fail("Unterminated child control JSONL record", true);
					});
					proc!.stdout!.on("data", stdout);
					proc!.stdout!.on("end", endStdout);
					proc!.stdout!.on("error", (error) => fail(`Child stdout error: ${errorText(error)}`, true));
					proc!.stderr!.on("data", (chunk: Buffer) => { writeLog(chunk); stderr(stderrDecoder.write(chunk)); });
					proc!.stderr!.on("end", () => stderr(stderrDecoder.end()));
					proc!.stderr!.on("error", (error) => fail(`Child stderr error: ${errorText(error)}`));
					proc!.on("error", (error) => fail(`Child process error: ${errorText(error)}`, true));
					proc!.on("exit", (code, exitSignal) => {
						exited = true;
						result.exitCode = code ?? 1;
						if (exitSignal) failure ??= `Child exited on signal ${exitSignal}`;
						// Clean up descendants even if the CLI itself exited successfully.
						if (treeAlive()) terminate();
					});
					proc!.on("close", (code, exitSignal) => {
						closed = true;
						exited = true;
						result.exitCode = code ?? 1;
						if (exitSignal) failure ??= `Child exited on signal ${exitSignal}`;
						endStdout();
						if (treeAlive()) terminate();
						maybeSettle();
					});
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) abort();
					emit();
				});
			}
		} catch (error) {
			fail(`Cannot run child: ${errorText(error)}`, true);
			result.exitCode = 1;
		} finally {
			signal.removeEventListener("abort", abort);
			if (graceTimer) clearTimeout(graceTimer);
			if (drainTimer) clearTimeout(drainTimer);
			if (updateTimer) clearTimeout(updateTimer);
			for (const fd of [logFd, outputFd]) {
				if (fd !== undefined) {
					try { fs.closeSync(fd); }
					catch (error) { failure ??= prefix(`Cannot close child artifact: ${errorText(error)}`, 16 * 1024); }
				}
			}
		}
		if (!ready && !cancelled) { failure ??= result.stderr.trim() ? prefix(result.stderr.trim(), 16 * 1024) : "Child did not emit subagent_ready"; protocolLost = true; }
		if (privateSummary) {
			committedUsage = privateSummary.usage;
			partialUsage = undefined;
			result.usageComplete = privateSummary.complete;
		}
		const final = snapshot();
		final.usageComplete = Boolean(result.usageComplete && !protocolLost && !hardKilled);
		final.state = cancelled ? "cancelled" : failure || result.exitCode !== 0 || ["error", "aborted", "pending", "deferred"].includes(result.stopReason ?? "") ? "failed" : "completed";
		if (failure) final.errorMessage = failure;
		else if (final.state === "failed" && !final.errorMessage) final.errorMessage = `Child failed (${result.stopReason ?? `exit ${result.exitCode}`})`;
		if (final.exitCode === -1 || (final.state === "failed" && final.exitCode === 0)) final.exitCode = 1;
		return final;
	};
}
