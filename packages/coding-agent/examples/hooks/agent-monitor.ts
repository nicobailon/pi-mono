/**
 * Agent Monitor Hook
 *
 * A dual-agent architecture where a monitoring agent watches the main agent's
 * actions and controls access to sensitive tools (Edit, Write).
 *
 * The monitor:
 * - Reviews each turn for potential issues (security, correctness, style)
 * - Accumulates flags that the main agent only sees when attempting edits
 * - Acts as an approval gate for file modifications
 *
 * Think of it as a code reviewer watching over the agent's shoulder.
 */

import { completeSimple, getModel } from "@mariozechner/pi-ai";
import type { Model, Api } from "@mariozechner/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { HookAPI, TurnEndEvent, ToolCallEvent, HookEventContext } from "@mariozechner/pi-coding-agent/hooks";

// Type helpers for message content
type TextContent = { type: "text"; text: string };
type ToolCallContent = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type ToolResultLike = { toolCallId: string; toolName?: string; content?: Array<{ type: string; text?: string }> };

// =============================================================================
// CONFIGURATION
// =============================================================================

const config = {
	/**
	 * Model for the monitoring agent.
	 * Use a fast, cheap model for quick reviews.
	 * Options: "claude-3-5-haiku-latest", "claude-haiku-4-5", "gpt-4o-mini", etc.
	 */
	model: getModel("anthropic", "claude-3-5-haiku-latest"),

	/**
	 * Tools that require approval from the monitor.
	 */
	gatedTools: ["edit", "write"] as const,

	/**
	 * Tools to monitor for issues (reviewed on turn_end).
	 */
	monitoredTools: ["bash", "edit", "write", "read"] as const,

	/**
	 * Maximum flags before auto-blocking (0 = no limit).
	 */
	maxFlags: 5,

	/**
	 * Enable verbose logging to stderr.
	 */
	verbose: false,
};

// =============================================================================
// TYPES
// =============================================================================

interface Flag {
	id: string;
	severity: "info" | "warning" | "critical";
	issue: string;
	context: string;
	timestamp: number;
}

interface MonitorDecision {
	approved: boolean;
	reason: string;
	newFlags?: Flag[];
}

// =============================================================================
// FLAG STORE
// =============================================================================

class FlagStore {
	private readonly path: string;

	constructor(sessionId: string) {
		this.path = join(tmpdir(), `agent-monitor-${sessionId}.json`);
	}

	get flags(): Flag[] {
		if (!existsSync(this.path)) return [];
		try {
			return JSON.parse(readFileSync(this.path, "utf-8"));
		} catch {
			return [];
		}
	}

	add(flag: Omit<Flag, "id" | "timestamp">): Flag {
		const newFlag: Flag = {
			...flag,
			id: crypto.randomUUID().slice(0, 8),
			timestamp: Date.now(),
		};
		const flags = [...this.flags, newFlag];
		writeFileSync(this.path, JSON.stringify(flags, null, 2));
		return newFlag;
	}

	clear(): void {
		if (existsSync(this.path)) unlinkSync(this.path);
	}

	format(): string {
		const flags = this.flags;
		if (flags.length === 0) return "";

		return flags
			.map((f) => {
				const icon = f.severity === "critical" ? "🔴" : f.severity === "warning" ? "🟡" : "🔵";
				return `${icon} [${f.severity.toUpperCase()}] ${f.issue}\n   Context: ${f.context}`;
			})
			.join("\n\n");
	}
}

// =============================================================================
// MONITOR AGENT
// =============================================================================

class MonitorAgent {
	private readonly model: Model<Api>;

	constructor(model: Model<Api>) {
		this.model = model;
	}

	/**
	 * Review a completed turn for potential issues.
	 */
	async reviewTurn(turnData: {
		assistantMessage: string;
		toolCalls: Array<{ name: string; input: unknown; result: string }>;
	}): Promise<Flag[]> {
		const prompt = `You are a code review monitor. Analyze this agent turn for issues.

AGENT'S RESPONSE:
${turnData.assistantMessage}

TOOL CALLS:
${turnData.toolCalls.map((t) => `- ${t.name}: ${JSON.stringify(t.input)}\n  Result: ${t.result.slice(0, 500)}...`).join("\n")}

Flag any of these issues:
- Security vulnerabilities (command injection, path traversal, secrets exposure)
- Destructive operations without confirmation
- Potential bugs or logic errors
- Style/best practice violations (only if severe)

Respond with JSON array of flags (empty if no issues):
[{"severity": "info|warning|critical", "issue": "brief description", "context": "relevant code/command"}]

Be concise. Only flag real issues, not minor style preferences.`;

		try {
			const response = await completeSimple(this.model, {
				systemPrompt: "You are a vigilant code reviewer. Output only valid JSON.",
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			});

			const text = response.content.find((c) => c.type === "text")?.text || "[]";
			const match = text.match(/\[[\s\S]*\]/);
			if (!match) return [];

			const parsed = JSON.parse(match[0]);
			return Array.isArray(parsed) ? parsed : [];
		} catch (e) {
			log("Review failed:", e);
			return [];
		}
	}

	/**
	 * Decide whether to approve a file modification.
	 */
	async approveEdit(request: {
		toolName: string;
		input: Record<string, unknown>;
		existingFlags: Flag[];
	}): Promise<MonitorDecision> {
		const flagSummary =
			request.existingFlags.length > 0
				? `EXISTING FLAGS:\n${request.existingFlags.map((f) => `- [${f.severity}] ${f.issue}`).join("\n")}`
				: "No existing flags.";

		const prompt = `You are a code review gatekeeper. Decide if this edit should proceed.

OPERATION: ${request.toolName}
${formatInput(request.input)}

${flagSummary}

Consider:
1. Does this edit address any existing flags?
2. Does this edit introduce new issues?
3. Is the edit safe and correct?

Respond with JSON:
{"approved": true/false, "reason": "brief explanation", "newFlags": [...optional new flags...]}`;

		try {
			const response = await completeSimple(this.model, {
				systemPrompt: "You are a careful code reviewer. Output only valid JSON. Approve unless there's a real problem.",
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			});

			const text = response.content.find((c) => c.type === "text")?.text || "{}";
			const match = text.match(/\{[\s\S]*\}/);
			if (!match) return { approved: true, reason: "Parse error - defaulting to approved" };

			return JSON.parse(match[0]);
		} catch (e) {
			log("Approval check failed:", e);
			return { approved: true, reason: "Error during check - defaulting to approved" };
		}
	}
}

// =============================================================================
// UTILITIES
// =============================================================================

function log(...args: unknown[]) {
	if (config.verbose) {
		console.error("[agent-monitor]", ...args);
	}
}

function formatInput(input: Record<string, unknown>): string {
	if (input.file_path) {
		const content = input.content || input.new_string || input.old_string;
		return `FILE: ${input.file_path}\nCONTENT:\n${String(content).slice(0, 1000)}`;
	}
	return JSON.stringify(input, null, 2).slice(0, 1000);
}

function getSessionId(ctx: HookEventContext): string {
	if (ctx.sessionFile) {
		return ctx.sessionFile.replace(/[^a-zA-Z0-9]/g, "-").slice(-32);
	}
	return "default";
}

// =============================================================================
// HOOK FACTORY
// =============================================================================

export default function (pi: HookAPI) {
	const monitor = new MonitorAgent(config.model);
	let flagStore: FlagStore | null = null;

	// Initialize flag store on session start
	pi.on("session", async (_event, ctx) => {
		flagStore = new FlagStore(getSessionId(ctx));
		log("Monitor initialized, flags:", flagStore.flags.length);
	});

	// Review completed turns for issues
	pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
		if (!flagStore) flagStore = new FlagStore(getSessionId(ctx));

		// Extract relevant data from the turn (use 'any' to handle union types)
		const messageContent = (event.message as any).content as unknown[];
		const assistantMessage = messageContent
			?.filter((c: any): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n") || "";

		const toolResults = event.toolResults as unknown as ToolResultLike[];
		const toolCalls = toolResults.map((result) => {
			const call = messageContent?.find(
				(c: any): c is ToolCallContent => c.type === "toolCall" && c.id === result.toolCallId,
			);
			return {
				name: call?.name || result.toolName || "unknown",
				input: call?.arguments || {},
				result:
					result.content
						?.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "",
			};
		});

		// Only review if monitored tools were used
		const monitoredSet = new Set<string>(config.monitoredTools);
		const hasMonitoredTools = toolCalls.some((t) => monitoredSet.has(t.name));
		if (!hasMonitoredTools) return;

		log("Reviewing turn with", toolCalls.length, "tool calls");

		const newFlags = await monitor.reviewTurn({ assistantMessage, toolCalls });
		for (const flag of newFlags) {
			const added = flagStore.add(flag);
			log("Flagged:", added.severity, "-", added.issue);

			if (ctx.hasUI) {
				const icon = flag.severity === "critical" ? "🔴" : flag.severity === "warning" ? "🟡" : "🔵";
				ctx.ui.notify(`${icon} Monitor: ${flag.issue}`, flag.severity === "critical" ? "error" : "warning");
			}
		}
	});

	// Gate file modifications
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		const gatedSet = new Set<string>(config.gatedTools);
		if (!gatedSet.has(event.toolName)) {
			return undefined;
		}

		if (!flagStore) flagStore = new FlagStore(getSessionId(ctx));
		const existingFlags = flagStore.flags;

		log("Approval gate for", event.toolName, "- existing flags:", existingFlags.length);

		// Auto-block if too many flags
		if (config.maxFlags > 0 && existingFlags.length >= config.maxFlags) {
			const flagReport = flagStore.format();
			return {
				block: true,
				reason: `🔴 BLOCKED: Too many unresolved issues (${existingFlags.length}/${config.maxFlags})\n\n${flagReport}\n\nAddress these issues before proceeding.`,
			};
		}

		// Ask monitor for approval
		const decision = await monitor.approveEdit({
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
			existingFlags,
		});

		// Add any new flags from this check
		if (decision.newFlags) {
			for (const flag of decision.newFlags) {
				flagStore.add(flag);
			}
		}

		if (!decision.approved) {
			const flagReport = flagStore.format();
			const report = flagReport ? `\n\nAccumulated issues:\n${flagReport}` : "";
			return {
				block: true,
				reason: `🔴 BLOCKED: ${decision.reason}${report}`,
			};
		}

		// Approved - clear resolved flags if edit addresses them
		if (existingFlags.length > 0) {
			log("Approved with", existingFlags.length, "existing flags");
		}

		// Show green light
		if (ctx.hasUI) {
			ctx.ui.notify("🟢 Edit approved", "info");
		}

		return undefined; // Allow execution
	});

	// Clear flags on session end
	pi.on("agent_end", async (_event, ctx) => {
		if (!flagStore) return;
		const remaining = flagStore.flags;
		if (remaining.length > 0) {
			log("Session ended with", remaining.length, "unresolved flags");
			// Optionally notify via pi.send() for next session
		}
	});
}
