import { Type } from "typebox";
import { MAX_PARALLEL_TASKS, THINKING_LEVELS } from "./config.ts";

const strict = { additionalProperties: false } as const;
const nonempty = () => Type.String({ minLength: 1, pattern: "\\S" });
const exactName = () => Type.String({ minLength: 1, pattern: "^\\S(?:.*\\S)?$" });
const stringEnum = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));

export const RunConfigSchema = Type.Object({
	model: Type.Optional(Type.String({ description: 'Exact provider/id or unique exact model ID; "inherit" uses the parent.' })),
	thinking: Type.Optional(stringEnum([...THINKING_LEVELS, "inherit"] as const)),
	rolePrompt: Type.Optional(Type.Object({
		replace: Type.Optional(Type.String({ description: "Replace the role prompt, not Pi's base system prompt. Empty text clears it." })),
		append: Type.Optional(Type.String({ description: "Append to the selected role prompt." })),
	}, strict)),
	systemPrompt: Type.Optional(Type.String({ description: "Explicitly replace Pi's base system prompt." })),
	tools: Type.Optional(Type.Object({
		allow: Type.Optional(Type.Array(Type.String({
			pattern: "^(?!(?:subagent|subagent_task)$)[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$",
			description: "Exact allowed tool names. Empty disables all tools; recursive delegation is forbidden.",
		}))),
		extensions: Type.Optional(Type.Array(exactName(), { description: "Explicit extension paths, relative to the invocation cwd. No automatic inheritance." })),
		mcp: Type.Optional(Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }), { description: "Explicit MCP server names. No automatic inheritance." })),
	}, strict)),
}, strict);

const TaskItem = Type.Object({
	agent: Type.Optional(exactName()),
	task: nonempty(),
	cwd: Type.Optional(exactName()),
	config: Type.Optional(RunConfigSchema),
}, strict);

const common = {
	config: Type.Optional(RunConfigSchema),
	cwd: Type.Optional(exactName()),
	agentScope: Type.Optional(stringEnum(["user", "project", "both"] as const)),
	background: Type.Optional(Type.Boolean({ description: "Run in the background and immediately return a task ID.", default: false })),
	notify: Type.Optional(Type.Boolean({ description: "Notify the parent about completed background results not already delivered in full.", default: true })),
	allowSharedWrites: Type.Optional(Type.Boolean({ description: "Explicitly permit parallel writers sharing a working directory.", default: false })),
};

/** Keep an object at the root for model tool APIs and ergonomic inferred parameters.
 * The oneOf constraints reject conflicting mode keys, even when their arrays are empty. */
export const SubagentParams = Type.Object({
	...common,
	agent: Type.Optional(exactName()),
	task: Type.Optional(nonempty()),
	tasks: Type.Optional(Type.Array(TaskItem, { minItems: 1, maxItems: MAX_PARALLEL_TASKS })),
	chain: Type.Optional(Type.Array(TaskItem, { minItems: 1 })),
}, {
	...strict,
	oneOf: [
		{ required: ["task"], not: { anyOf: [{ required: ["tasks"] }, { required: ["chain"] }] } },
		{ required: ["tasks"], not: { anyOf: [{ required: ["agent"] }, { required: ["task"] }, { required: ["chain"] }] } },
		{ required: ["chain"], not: { anyOf: [{ required: ["agent"] }, { required: ["task"] }, { required: ["tasks"] }] } },
	],
});

const management = {
	cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Byte offset for incremental output/log reads." })),
	view: Type.Optional(stringEnum(["output", "log"] as const)),
	maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
};

export const TaskManagementParams = Type.Object({
	...management,
	action: stringEnum(["list", "status", "result", "cancel"] as const),
	taskId: Type.Optional(exactName()),
}, {
	...strict,
	anyOf: [
		{ properties: { action: { const: "list" } } },
		{ required: ["taskId"] },
	],
});
