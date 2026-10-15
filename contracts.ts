import type { Message } from "@earendil-works/pi-ai";

export type AgentScope = "user" | "project" | "both";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface RunConfig {
	model?: string;
	thinking?: ThinkingLevel | "inherit";
	timeoutMs?: number;
	rolePrompt?: { replace?: string; append?: string };
	systemPrompt?: string;
	tools?: { allow?: string[]; extensions?: string[]; mcp?: string[] };
}
export interface TaskInput { agent?: string; task: string; cwd?: string; config?: RunConfig }
export interface RunRequest {
	agent?: string;
	task?: string;
	tasks?: TaskInput[];
	chain?: TaskInput[];
	config?: RunConfig;
	cwd?: string;
	agentScope?: AgentScope;
	background?: boolean;
	notify?: boolean;
	allowSharedWrites?: boolean;
}
export interface ResolvedTask {
	agent: string;
	agentSource: "user" | "project" | "inline";
	agentFile?: string;
	shadowedFiles: string[];
	task: string;
	cwd: string;
	model: string;
	thinking: ThinkingLevel;
	timeoutMs?: number;
	rolePrompt: string;
	systemPrompt?: string;
	tools: { allow: string[]; extensions: string[]; mcp: string[] };
	readOnly: boolean;
	provenance: Record<string, string>;
}
export interface ResolvedRun {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	tasks: ResolvedTask[];
	background: boolean;
	notify: boolean;
	allowSharedWrites: boolean;
}
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	reasoning: number;
	totalTokens: number;
	cost: number;
	costBreakdown: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextTokens: number;
	turns: number;
}
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, totalTokens: 0,
		cost: 0, costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextTokens: 0, turns: 0 };
}
export type TaskState = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "skipped";
export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "inline" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	usageComplete?: boolean;
	model?: string;
	thinking?: ThinkingLevel;
	stopReason?: string;
	timedOut?: boolean;
	errorMessage?: string;
	step?: number;
	state?: TaskState;
	itemId?: string;
	resolved?: ResolvedTask;
	output?: string;
	outputTruncated?: boolean;
	logTruncated?: boolean;
}
export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	taskId?: string;
	state?: TaskState;
	usage?: UsageStats;
	/** Complete retained output reached successful finalized parent tool results; not acceptance. */
	resultDelivered?: boolean;
	expired?: boolean;
}
export interface CompletionNotice {
	taskId: string;
	state: TaskState;
	expired: boolean;
	usage: UsageStats;
}
export interface ResultPage {
	text: string;
	cursor: number;
	view: "output" | "log";
	nextCursor: number | null;
	totalBytes: number;
	truncated: boolean;
	state: TaskState;
}
export interface ChildConfig {
	task: ResolvedTask;
	mcpServers: Array<{ name: string; config: Record<string, unknown>; source: string }>;
}
export interface RunnerFiles { dir: string; configPath: string; logPath: string; outputPath: string }
export type RunChild = (
	task: ResolvedTask, files: RunnerFiles, signal: AbortSignal,
	onUpdate: (result: SingleResult) => void,
) => Promise<SingleResult>;

/** Only these tools have a built-in, reviewed read-only implementation. Names and hints from
 * arbitrary extensions or MCP servers are not sufficient authority for Plan Mode. */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const RECURSIVE_TOOLS = new Set(["subagent", "subagent_task"]);
