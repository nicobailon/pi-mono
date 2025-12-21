import type { TransportName } from "../transport/types.js";

export interface HookMeta {
	name: string;
	version?: string;
	description?: string;
}

export interface HookLog {
	info(message: string): void;
	warn(message: string): void;
	debug(message: string): void;
}

export interface ChannelInfo {
	id: string;
	name?: string;
	guildId?: string;
	guildName?: string;
}

interface SharedContext {
	transport: TransportName;
	workingDir: string;
	channelDir: string;
	hookDir: string;
	hookName: string;
	channel: ChannelInfo;
	log: HookLog;
	send(text: string): Promise<void>;
	getHookSettings<T>(): T | undefined;
	signal: AbortSignal;
}

export interface MessageEventContext extends SharedContext {
	event: "message";
	timestamp: string;
	message: {
		id: string;
		text: string;
		userId: string;
		userName?: string;
		displayName?: string;
		isBot: boolean;
		isMention: boolean;
		threadTs?: string;
		replyToMessageId?: string;
		attachments: Array<{ name: string; localPath?: string }>;
	};
}

export interface ReactionEventContext extends SharedContext {
	event: "reaction_added" | "reaction_removed";
	timestamp: string;
	reaction: {
		targetMessageId: string;
		emoji: string;
		userId: string;
		userName?: string;
		displayName?: string;
	};
}

export type TransportEventContext = MessageEventContext | ReactionEventContext;

export interface RunHookContext extends SharedContext {
	message: {
		text: string;
		rawText: string;
		messageId: string;
		timestamp: string;
		attachments: Array<{ localPath: string }>;
	};
	user: {
		id: string;
		userName?: string;
		displayName?: string;
		email?: string;
	};
	reply: {
		primary(text: string): Promise<void>;
		secondary(text: string): Promise<void>;
	};
}

export interface ContextEntry {
	role: "user" | "assistant";
	content: string;
}

export interface MessagePatch {
	text?: string;
	attachments?: Array<{ localPath: string }>;
}

export type BeforeRunResult =
	| { action: "proceed" }
	| { action: "block"; reply?: string }
	| { action: "modify"; patch: MessagePatch }
	| { action: "injectContext"; entries: ContextEntry[]; patch?: MessagePatch };

export interface RunResult {
	stopReason: "end_turn" | "stop" | "max_tokens" | "error" | "aborted" | string;
	errorMessage?: string;
	wasSilent?: boolean;
	durationMs: number;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
	toolCalls: Array<{ toolName: string; count: number }>;
}

export type ErrorAction = { action: "default" } | { action: "suppress" } | { action: "reply"; message: string };

export interface LoadedHook {
	name: string;
	path: string;
	resolvedPath: string;
	meta?: HookMeta;
	beforeRun?: (ctx: RunHookContext) => Promise<BeforeRunResult | undefined>;
	afterRun?: (ctx: RunHookContext, result: RunResult) => Promise<void>;
	onError?: (ctx: RunHookContext, error: Error) => Promise<ErrorAction | undefined>;
	onMessage?: (ctx: MessageEventContext) => Promise<void>;
	onReaction?: (ctx: ReactionEventContext) => Promise<void>;
}

export interface LoadHooksResult {
	hooks: LoadedHook[];
	errors: Array<{ path: string; error: string }>;
}
