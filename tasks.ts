import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emptyUsage, type ChildConfig, type CompletionNotice, type ResolvedRun, type ResolvedTask, type ResultPage, type RunChild, type RunnerFiles, type SingleResult, type SubagentDetails, type TaskState, type UsageStats } from "./contracts.ts";
import { aggregateUsage, getFinalOutput } from "./process-runner.ts";

const executeFile = promisify(execFile);
const terminal = (state?: TaskState): boolean => ["completed", "failed", "cancelled", "skipped"].includes(state ?? "");
const failure = (error: unknown): string => error instanceof Error ? error.message : String(error);
export function resultOutput(result: SingleResult): string { return result.output ?? getFinalOutput(result.messages); }
export function resultFailed(result: SingleResult): boolean { return result.state === "failed" || result.state === "cancelled" || result.exitCode !== 0 || ["error", "aborted"].includes(result.stopReason ?? ""); }
export async function workspaceForCwd(cwd: string): Promise<string> {
	const canonical = await fs.realpath(cwd);
	try {
		const { stdout } = await executeFile("git", ["-C", canonical, "rev-parse", "--show-toplevel"], { timeout: 2000, maxBuffer: 8192 });
		return await fs.realpath(stdout.trim());
	} catch { return canonical; }
}
function overlapping(a: string, b: string): boolean {
	return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}
class Slots {
	private used = 0;
	private waiting: Array<() => void> = [];
	constructor(private capacity: number) {}
	acquire(signal: AbortSignal): Promise<() => void> {
		return new Promise((resolve, reject) => {
			let granted = false;
			const abort = () => {
				if (granted) return;
				this.waiting = this.waiting.filter((entry) => entry !== grant);
				signal.removeEventListener("abort", abort);
				reject(new Error("Cancelled while queued"));
			};
			const grant = () => {
				if (signal.aborted) { abort(); return; }
				granted = true; signal.removeEventListener("abort", abort); this.used++;
				let released = false;
				resolve(() => { if (released) return; released = true; this.used--; this.waiting.shift()?.(); });
			};
			if (signal.aborted) { abort(); return; }
			signal.addEventListener("abort", abort, { once: true });
			if (this.used < this.capacity) grant(); else this.waiting.push(grant);
		});
	}
}
interface Job {
	id: string; run: ResolvedRun; state: TaskState; controller: AbortController; results: SingleResult[];
	files: RunnerFiles[]; workspaces: string[]; done: Promise<SubagentDetails>;
	startedAt: number; finishedAt?: number; expired: boolean; suppressNotification: boolean; notificationSent: boolean;
	resultDelivered: boolean; deliveredRanges: Array<[number, number]>; deliveryTotal?: number;
	update?: (details: SubagentDetails) => void;
}
export interface TaskManagerOptions {
	runner: RunChild;
	prepare?: (task: ResolvedTask) => Promise<ChildConfig> | ChildConfig;
	workspace?: (cwd: string) => Promise<string>;
	onComplete?: (details: SubagentDetails) => void | Promise<void>;
	onUsage?: (usage: UsageStats) => void;
	baselineUsage?: UsageStats;
	concurrency?: number;
	maxActiveTasks?: number;
	maxRetainedJobs?: number;
	maxRetainedBytes?: number;
	tmpRoot?: string;
}

/** One session owns scheduling, cancellation, files and the accounting ledger. Queries are pure
 * snapshots; totals are never incremented by progress/render/query/notification paths. */
export class SessionTasks {
	private jobs = new Map<string, Job>();
	private baseline: UsageStats;
	private retired = emptyUsage();
	private slots: Slots;
	private root?: string;
	private closed = false;
	private admissions: Promise<unknown> = Promise.resolve();
	private cleanup?: Promise<void>;
	private pruning: Promise<void> = Promise.resolve();
	// Receipts bind a page to the actual model-visible text, not merely a read or tool hint.
	private deliveryAttempts = new Map<string, { taskId: string; cursor: number; end: number; total: number; hash: string }>();
	constructor(private options: TaskManagerOptions) {
		this.baseline = structuredClone(options.baselineUsage ?? emptyUsage());
		this.slots = new Slots(Math.max(1, options.concurrency ?? 4));
	}
	usage(): UsageStats { return aggregateUsage([this.baseline, this.retired, ...[...this.jobs.values()].flatMap((job) => job.results.map((result) => result.usage))]); }
	private snapshot(job: Job): SubagentDetails {
		return structuredClone({ mode: job.run.mode, agentScope: job.run.agentScope, projectAgentsDir: job.run.projectAgentsDir,
			results: job.results, taskId: job.id, state: job.state, resultDelivered: job.resultDelivered, expired: job.expired,
			usage: aggregateUsage(job.results.map((result) => result.usage)) });
	}
	private publish(job: Job): void { try { job.update?.(this.snapshot(job)); } catch { /* UI errors do not own the job */ } }
	private get(id: string): Job { const job = this.jobs.get(id); if (!job) throw new Error(`Unknown or expired session task: ${id}`); return job; }
	status(id: string): SubagentDetails { return this.snapshot(this.get(id)); }
	list(): Array<{ taskId: string; state: TaskState; mode: ResolvedRun["mode"]; startedAt: number; finishedAt?: number; expired: boolean; resultDelivered: boolean; progress: { total: number; done: number }; usage: UsageStats }> {
		return [...this.jobs.values()].map((job) => ({ taskId: job.id, state: job.state, mode: job.run.mode,
			startedAt: job.startedAt, finishedAt: job.finishedAt, expired: job.expired, resultDelivered: job.resultDelivered,
			progress: { total: job.results.length, done: job.results.filter((result) => terminal(result.state)).length },
			usage: aggregateUsage(job.results.map((result) => result.usage)) }));
	}
	/** Notifications are hints; dispatch eligibility is independent of retained results and usage. */
	pendingNotifications(): CompletionNotice[] {
		if (this.closed) return [];
		return [...this.jobs.values()].filter((job) => terminal(job.state) && job.run.background && job.run.notify &&
			!job.suppressNotification && !job.notificationSent && !job.resultDelivered).map((job) => ({ taskId: job.id,
				state: job.state, expired: job.expired, usage: aggregateUsage(job.results.map((result) => result.usage)) }));
	}
	takeNotifications(): CompletionNotice[] {
		const notices = this.pendingNotifications();
		for (const notice of notices) this.get(notice.taskId).notificationSent = true;
		return notices;
	}
	trackDelivery(callId: string, id: string, page: ResultPage, text: string): void {
		const job = this.jobs.get(id);
		if (this.closed || !job || job.resultDelivered || page.view !== "output" || !terminal(page.state)) return;
		this.deliveryAttempts.set(callId, { taskId: id, cursor: page.cursor, end: page.nextCursor ?? page.totalBytes,
			total: page.totalBytes, hash: createHash("sha256").update(JSON.stringify([{ type: "text", text }])).digest("hex") });
	}
	observeDelivery(message: ToolResultMessage): void {
		const receipt = this.deliveryAttempts.get(message.toolCallId);
		if (!receipt) return;
		this.deliveryAttempts.delete(message.toolCallId);
		const job = this.jobs.get(receipt.taskId);
		if (this.closed || !job || job.resultDelivered || message.isError || message.toolName !== "subagent_task" ||
			createHash("sha256").update(JSON.stringify(message.content)).digest("hex") !== receipt.hash) return;
		if (job.deliveryTotal !== receipt.total) { job.deliveryTotal = receipt.total; job.deliveredRanges = []; }
		const ranges = [...job.deliveredRanges, [receipt.cursor, receipt.end] as [number, number]].sort((a, b) => a[0] - b[0]);
		job.deliveredRanges = [];
		for (const range of ranges) {
			const last = job.deliveredRanges.at(-1);
			if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
			else job.deliveredRanges.push(range);
		}
		job.resultDelivered = job.deliveredRanges.length === 1 && job.deliveredRanges[0][0] === 0 && job.deliveredRanges[0][1] === receipt.total;
		if (job.resultDelivered) job.deliveredRanges = [];
	}
	clearDeliveryAttempts(): void { this.deliveryAttempts.clear(); }
	async start(run: ResolvedRun, callerSignal?: AbortSignal, onUpdate?: (details: SubagentDetails) => void): Promise<{ taskId: string; done: Promise<SubagentDetails> }> {
		// Serialize admission, not execution: two simultaneous calls cannot both miss a writer reservation.
		const admitted = this.admissions.then(() => this.admit(run, callerSignal, onUpdate));
		this.admissions = admitted.catch(() => {});
		return admitted;
	}
	private async admit(input: ResolvedRun, signal?: AbortSignal, update?: (details: SubagentDetails) => void): Promise<{ taskId: string; done: Promise<SubagentDetails> }> {
		if (this.closed) throw new Error("Subagent session is shutting down");
		if (signal?.aborted) throw new Error("Subagent launch cancelled");
		const run = structuredClone(input);
		const active = [...this.jobs.values()].filter((job) => !terminal(job.state));
		if (active.reduce((total, job) => total + job.results.length, run.tasks.length) > (this.options.maxActiveTasks ?? 32)) throw new Error("Too many active or queued subagent tasks (default limit 32)");
		const workspaces = await Promise.all(run.tasks.map((task) => (this.options.workspace ?? workspaceForCwd)(task.cwd)));
		const writers = run.tasks.flatMap((task, index) => task.readOnly ? [] : [workspaces[index]]);
		if (run.mode === "parallel" && !run.allowSharedWrites && writers.some((a, i) => writers.slice(i + 1).some((b) => overlapping(a, b)))) {
			throw new Error("Parallel writers share a worktree. Set allowSharedWrites: true explicitly, or use separate worktrees/a chain.");
		}
		for (const job of active) {
			const existing = job.run.tasks.flatMap((task, i) => task.readOnly ? [] : [job.workspaces[i]]);
			if (!(run.allowSharedWrites && job.run.allowSharedWrites) && writers.some((a) => existing.some((b) => overlapping(a, b)))) {
				throw new Error(`Writer conflicts with active task ${job.id}. Both runs must explicitly allowSharedWrites, or use separate worktrees.`);
			}
		}
		const prepared = await Promise.all(run.tasks.map(async (task) => {
			const config = await (this.options.prepare?.(task) ?? { task, mcpServers: [] });
			const text = JSON.stringify(config);
			if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Subagent task/config exceeds 256 KiB");
			return text;
		}));
		if (this.closed || signal?.aborted) throw new Error("Subagent launch cancelled during preparation");
		this.root ??= await fs.mkdtemp(path.join(this.options.tmpRoot ?? os.tmpdir(), "pi-subagent-session-"));
		await fs.chmod(this.root, 0o700);
		const id = randomUUID();
		const dir = path.join(this.root, id);
		let files: RunnerFiles[];
		try {
			files = await Promise.all(prepared.map(async (text, index) => {
				const itemDir = path.join(dir, String(index + 1));
				await fs.mkdir(itemDir, { recursive: true, mode: 0o700 });
				const configPath = path.join(itemDir, "config.json");
				await fs.writeFile(configPath, text, { mode: 0o600 });
				return { dir: itemDir, configPath, logPath: path.join(itemDir, "events.log"), outputPath: path.join(itemDir, "output.txt") };
			}));
		} catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
		if (this.closed || signal?.aborted) { await fs.rm(dir, { recursive: true, force: true }); throw new Error("Subagent launch cancelled"); }
		const controller = new AbortController();
		const job: Job = { id, run, controller, files, workspaces, state: "queued", startedAt: Date.now(), expired: false,
			suppressNotification: false, notificationSent: false, resultDelivered: false, deliveredRanges: [], update, done: undefined!, results: run.tasks.map((task, index) => ({ agent: task.agent,
				agentSource: task.agentSource, task: task.task, model: task.model, thinking: task.thinking,
				resolved: task, exitCode: -1, state: "queued", itemId: `${id}/${index + 1}`, step: run.mode === "chain" ? index + 1 : undefined,
				messages: [], stderr: "", usage: emptyUsage(), output: "" })) };
		this.jobs.set(id, job);
		const abort = () => { if (terminal(job.state)) return; job.state = "cancelling"; controller.abort(); this.publish(job); };
		// Background tasks detach from the launching turn only AFTER successful admission.
		if (!run.background && signal) { signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }
		job.done = this.execute(job).finally(() => signal?.removeEventListener("abort", abort));
		return { taskId: id, done: job.done };
	}
	private async item(job: Job, index: number, previous = ""): Promise<void> {
		const placeholder = job.results[index];
		let release: (() => void) | undefined;
		try {
			release = await this.slots.acquire(job.controller.signal);
			if (job.controller.signal.aborted) throw new Error("Cancelled before execution");
			job.state = "running"; placeholder.state = "running";
			const task = { ...job.run.tasks[index], task: job.run.mode === "chain" ? job.run.tasks[index].task.replace(/\{previous\}/g, () => previous) : job.run.tasks[index].task };
			// Chain task expansion must reach BOTH the CLI prompt and the bootstrap snapshot.
			const config: ChildConfig = JSON.parse(await fs.readFile(job.files[index].configPath, "utf8"));
			config.task = task;
			if (Buffer.byteLength(JSON.stringify(config)) > 512 * 1024) throw new Error("Expanded chain task/config exceeds 512 KiB");
			await fs.writeFile(job.files[index].configPath, JSON.stringify(config), { mode: 0o600 });
			this.publish(job);
			if (job.controller.signal.aborted) throw new Error("Cancelled before child launch");
			const result = await this.options.runner(task, job.files[index], job.controller.signal, (result) => {
				job.results[index] = { ...result, itemId: placeholder.itemId, step: placeholder.step, state: job.controller.signal.aborted ? "cancelling" : "running" };
				this.publish(job);
			});
			job.results[index] = { ...result, itemId: placeholder.itemId, step: placeholder.step,
				state: job.controller.signal.aborted ? "cancelled" : result.state ?? (resultFailed(result) ? "failed" : "completed") };
		} catch (error) {
			job.results[index] = { ...job.results[index], exitCode: 1, state: job.controller.signal.aborted ? "cancelled" : "failed", errorMessage: failure(error) };
		} finally { release?.(); await fs.rm(job.files[index].configPath, { force: true }).catch(() => {}); this.publish(job); }
	}
	private async execute(job: Job): Promise<SubagentDetails> {
		try {
			if (job.run.mode === "chain") {
				let previous = "";
				for (let i = 0; i < job.results.length; i++) {
					await this.item(job, i, previous);
					if (resultFailed(job.results[i])) {
						for (let j = i + 1; j < job.results.length; j++) job.results[j] = { ...job.results[j], state: job.controller.signal.aborted ? "cancelled" : "skipped", exitCode: 1 };
						break;
					}
					previous = resultOutput(job.results[i]);
				}
			} else await Promise.all(job.results.map((_result, index) => this.item(job, index)));
		} finally {
			// Never retain prompt/config snapshots (which may contain MCP credentials).
			await Promise.all(job.files.map((files) => fs.rm(files.configPath, { force: true }).catch(() => {})));
			job.state = job.controller.signal.aborted ? "cancelled" : job.results.some(resultFailed) ? "failed" : "completed";
			job.finishedAt = Date.now();
			this.publish(job);
			try { this.options.onUsage?.(this.usage()); } catch { /* accounting remains queryable */ }
		}
		const details = this.snapshot(job);
		if (!this.closed && job.run.background && job.run.notify && !job.suppressNotification) {
			try { await this.options.onComplete?.(details); } catch { /* result retrieval is still available */ }
		}
		await this.prune().catch(() => {});
		return details;
	}
	async cancel(id: string, suppressNotification = false): Promise<SubagentDetails> {
		const job = this.get(id);
		job.suppressNotification ||= suppressNotification;
		if (!terminal(job.state)) { job.state = "cancelling"; job.controller.abort(); this.publish(job); }
		return job.done;
	}
	async cancelWriters(): Promise<void> { await Promise.all([...this.jobs.values()].filter((job) => !terminal(job.state) && job.run.tasks.some((task) => !task.readOnly)).map((job) => this.cancel(job.id, true))); }
	async cancelAll(suppressNotification = true): Promise<void> {
		if (suppressNotification) { for (const job of this.jobs.values()) job.suppressNotification = true; this.clearDeliveryAttempts(); }
		await Promise.all([...this.jobs.values()].filter((job) => !terminal(job.state)).map((job) => this.cancel(job.id, suppressNotification)));
	}
	async read(id: string, options: { cursor?: number; maxBytes?: number; view?: "output" | "log" } = {}): Promise<ResultPage> {
		const job = this.get(id);
		if (job.expired) throw new Error("Task artifacts expired; usage and status remain available until metadata eviction");
		const cursor = options.cursor ?? 0;
		const maxBytes = Math.min(options.maxBytes ?? 16 * 1024, 50 * 1024);
		if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid result cursor/maxBytes");
		if (options.view !== undefined && options.view !== "output" && options.view !== "log") throw new Error("Invalid result view");
		// Admit output reads only after completion, before any asynchronous file snapshots.
		if (!terminal(job.state) && options.view !== "log") throw new Error("Task is not finished; use status or view: log");
		const parts = await Promise.all(job.results.map(async (result, index) => {
			const file = options.view === "log" ? job.files[index].logPath : job.files[index].outputPath;
			let data: Buffer;
			try { data = await fs.readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; data = Buffer.alloc(0); }
			const heading = Buffer.from(`### [${index + 1}: ${result.agent}] ${result.state}\n\n`);
			const diagnostics = options.view === "log" ? "" : result.errorMessage || (resultFailed(result) ? result.stderr : "");
			return Buffer.concat([heading, data, Buffer.from(diagnostics ? `\n\nError: ${diagnostics}\n` : "\n")]);
		}));
		const data = Buffer.concat(parts);
		if (job.expired) throw new Error("Task artifacts expired during read");
		if (cursor < data.length && (data[cursor] & 0xc0) === 0x80) throw new Error("Result cursor is not a UTF-8 character boundary");
		if (cursor > data.length) throw new Error("Result cursor exceeds current output length");
		let end = Math.min(cursor + maxBytes, data.length);
		while (end > cursor && end < data.length && (data[end] & 0xc0) === 0x80) end--;
		if (end === cursor && end < data.length) { end++; while (end < data.length && (data[end] & 0xc0) === 0x80) end++; }
		return { text: data.subarray(cursor, end).toString("utf8"), cursor, view: options.view ?? "output", nextCursor: end < data.length ? end : null, totalBytes: data.length,
			truncated: job.results.some((result) => options.view === "log" ? result.logTruncated : result.outputTruncated), state: job.state };
	}
	private prune(): Promise<void> {
		const next = this.pruning.then(() => this.pruneNow());
		this.pruning = next.catch(() => {});
		return next;
	}
	private async pruneNow(): Promise<void> {
		const completed = [...this.jobs.values()].filter((job) => terminal(job.state)).sort((a, b) => a.finishedAt! - b.finishedAt!);
		const bytes = new Map<string, number>();
		for (const job of completed) bytes.set(job.id, (await Promise.all(job.files.flatMap((files) => [files.logPath, files.outputPath]).map(async (file) => {
			try { return (await fs.stat(file)).size; } catch { return 0; }
		}))).reduce((a, b) => a + b, 0));
		let total = [...bytes.values()].reduce((a, b) => a + b, 0);
		for (const job of completed) {
			if (completed.filter((item) => !item.expired).length <= (this.options.maxRetainedJobs ?? 16) && total <= (this.options.maxRetainedBytes ?? 64 * 1024 * 1024)) break;
			if (job.expired) continue;
			// Readers must fail closed before deletion can expose a partial/missing snapshot.
			job.expired = true;
			await fs.rm(path.dirname(job.files[0].dir), { recursive: true, force: true });
			total -= bytes.get(job.id) ?? 0;
			for (const result of job.results) { result.messages = []; result.output = undefined; result.stderr = ""; }
		}
		// Bounded tombstones: retire accounting rather than forget it when metadata is evicted.
		const expired = completed.filter((job) => job.expired);
		for (const job of expired.slice(0, Math.max(0, expired.length - 32))) {
			this.retired = aggregateUsage([this.retired, ...job.results.map((result) => result.usage)]);
			this.jobs.delete(job.id);
			for (const [callId, receipt] of this.deliveryAttempts) if (receipt.taskId === job.id) this.deliveryAttempts.delete(callId);
		}
	}
	shutdown(): Promise<void> {
		if (this.cleanup) return this.cleanup;
		this.closed = true; this.clearDeliveryAttempts();
		for (const job of this.jobs.values()) { job.suppressNotification = true; if (!terminal(job.state)) job.controller.abort(); }
		this.cleanup = (async () => {
			await this.admissions;
			await Promise.all([...this.jobs.values()].map((job) => job.done));
			try { this.options.onUsage?.(this.usage()); } catch { /* host may already be invalidated */ }
			if (this.root) await fs.rm(this.root, { recursive: true, force: true });
		})();
		return this.cleanup;
	}
}
