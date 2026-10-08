/** OPTIONAL replacement for the old name/type-based Plan Mode extension. Not auto-installed. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
const READ = ["read", "grep", "find", "ls", "web_search", "fetch_content", "source_check", "get_search_content"];
const ACTIVE = [...READ, "subagent", "subagent_task"];
export default function planMode(pi: ExtensionAPI): void {
	let enabled = false;
	let previous: string[] | undefined;
	pi.registerFlag("plan", { type: "boolean", default: false, description: "Start in read-only Plan Mode" });
	async function setMode(next: boolean, ctx: ExtensionContext, persist = true): Promise<void> {
		if (next && !enabled) previous = pi.getActiveTools();
		enabled = next;
		pi.setActiveTools(next ? ACTIVE : previous ?? pi.getActiveTools());
		if (!next) previous = undefined;
		if (persist) pi.appendEntry("plan-mode-state", { enabled, toolsBeforePlanMode: previous });
		const waiters: Promise<void>[] = [];
		pi.events.emit("plan-mode:changed", { enabled, waiters });
		await Promise.all(waiters);
		if (ctx.mode === "tui") ctx.ui.setStatus("plan-mode", enabled ? "plan: read-only" : undefined);
	}
	pi.registerCommand("plan", { description: "Toggle read-only planning: /plan [on|off|status]", handler: async (args, ctx) => {
		const action = args.trim().toLowerCase();
		if (action === "status") { ctx.ui.notify(`Plan Mode ${enabled ? "on" : "off"}`, "info"); return; }
		if (!["", "toggle", "on", "off"].includes(action)) { ctx.ui.notify("Usage: /plan [on|off|status]", "warning"); return; }
		await setMode(action === "on" ? true : action === "off" ? false : !enabled, ctx);
	} });
	pi.on("before_agent_start", (event) => enabled ? { systemPrompt: `${event.systemPrompt}\n\n<plan_mode>Investigate and plan only. Do not edit files or implement. Subagents must use reviewed read-only built-in tools without external sources; the subagent extension checks their resolved permissions. Background results grant no permissions. Ask the user to run /plan off before implementation.</plan_mode>` } : undefined);
	pi.on("tool_call", (event) => {
		if (!enabled || READ.includes(event.toolName) || event.toolName === "subagent_task") return;
		// Delegation is checked INSIDE subagent against resolved permissions, not a user-controlled
		// role name or type field. Only load this companion with this subagent implementation.
		if (event.toolName === "subagent") return;
		return { block: true, reason: `Plan Mode blocks ${event.toolName}; use /plan off before implementation` };
	});
	pi.on("session_start", async (_event, ctx) => {
		const entry = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === "plan-mode-state");
		const state = entry?.type === "custom" ? entry.data as { enabled?: boolean; toolsBeforePlanMode?: string[] } : undefined;
		previous = state?.toolsBeforePlanMode;
		// Preserve the original loadout when restoring an already-enabled mode.
		enabled = state?.enabled === true;
		await setMode(state?.enabled ?? pi.getFlag("plan") === true, ctx, false);
	});
}
