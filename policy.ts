import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedRun } from "./contracts.ts";

/** Compatibility with existing Plan Mode state, independent of role names. A companion extension
 * emits plan-mode:changed for immediate cancellation of writers; the parent also checks each run. */
export function isPlanMode(ctx: Pick<ExtensionContext, "sessionManager">, flag = false): boolean {
	const entry = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === "plan-mode-state");
	if (entry?.type === "custom" && entry.data && typeof entry.data === "object" && "enabled" in entry.data) return (entry.data as { enabled: unknown }).enabled === true;
	return flag;
}
export function enforcePlanMode(run: ResolvedRun): void {
	const forbidden = run.tasks.filter((task) => !task.readOnly);
	if (forbidden.length) throw new Error(`Plan Mode only permits reviewed read-only built-in tools (read, grep, find, ls), without external tool sources. Rejected: ${forbidden.map((task) => task.agent).join(", ")}`);
}
