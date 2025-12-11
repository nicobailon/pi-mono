// Hook system types

export type { CutPointResult } from "./core/compaction.js";
export {
	findCutPoint,
	findLatestCompactionIndex,
	SUMMARIZATION_PROMPT,
	stripAnalysisTags,
} from "./core/compaction.js";
export type {
	AgentEndEvent,
	AgentStartEvent,
	BranchEvent,
	BranchEventResult,
	HookAPI,
	HookEvent,
	HookEventContext,
	HookFactory,
	HookUIContext,
	PostCompactionEvent,
	PreCompactionEvent,
	PreCompactionResult,
	SessionStartEvent,
	SessionSwitchEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	TurnStartEvent,
} from "./core/hooks/index.js";
export type { SessionEntry } from "./core/session-manager.js";
export { SessionManager } from "./core/session-manager.js";
export { bashTool, codingTools, editTool, readTool, writeTool } from "./core/tools/index.js";
export { main } from "./main.js";
