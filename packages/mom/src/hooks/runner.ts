import { join } from "path";
import * as log from "../log.js";
import type { TransportName } from "../transport/types.js";
import type {
	BeforeRunResult,
	ContextEntry,
	ErrorAction,
	HookLog,
	LoadedHook,
	MessageEventContext,
	MessagePatch,
	ReactionEventContext,
	RunHookContext,
	RunResult,
	TransportEventContext,
} from "./types.js";

const DEFAULT_TIMEOUT = 5000;

export interface HookRunnerConfig {
	hooks: LoadedHook[];
	workingDir: string;
	getSettings: () => { transportEventTimeout?: number };
	getHookSettings: <T>(hookName: string) => T | undefined;
}

interface QueuedEvent {
	hook: LoadedHook;
	ctx: Omit<TransportEventContext, "signal">;
	handler: (ctx: TransportEventContext) => Promise<void>;
}

export class HookRunner {
	private hooks: LoadedHook[];
	private workingDir: string;
	private getSettings: () => { transportEventTimeout?: number };
	private getHookSettings: <T>(hookName: string) => T | undefined;
	private isRunActive = false;
	private eventQueue: QueuedEvent[] = [];

	constructor(config: HookRunnerConfig) {
		this.hooks = config.hooks;
		this.workingDir = config.workingDir;
		this.getSettings = config.getSettings;
		this.getHookSettings = config.getHookSettings;
	}

	private createLog(hookName: string): HookLog {
		return {
			info: (msg: string) => log.logInfo(`[hook:${hookName}] ${msg}`),
			warn: (msg: string) => log.logWarning(`[hook:${hookName}]`, msg),
			debug: (msg: string) => log.logInfo(`[hook:${hookName}] [debug] ${msg}`),
		};
	}

	private timeout(): number {
		return this.getSettings().transportEventTimeout ?? DEFAULT_TIMEOUT;
	}

	private async withTimeout<T>(
		fn: (signal: AbortSignal) => Promise<T>,
		hookName: string,
		action: string,
	): Promise<T | undefined> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout());
		try {
			return await Promise.race([
				fn(controller.signal),
				new Promise<never>((_, reject) => {
					controller.signal.addEventListener("abort", () =>
						reject(new Error(`${action} timed out after ${this.timeout()}ms`)),
					);
				}),
			]);
		} catch (err) {
			log.logWarning(`[hook:${hookName}] ${action} error`, err instanceof Error ? err.message : String(err));
			return undefined;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private buildRunContext(hook: LoadedHook, params: RunHookParams): RunHookContext {
		return {
			transport: params.transport,
			workingDir: this.workingDir,
			channelDir: params.channelDir,
			hookDir: join(params.channelDir, ".hooks", hook.name),
			hookName: hook.name,
			message: params.message,
			user: params.user,
			channel: params.channel,
			reply: params.reply,
			send: params.sendFn,
			signal: params.signal,
			log: this.createLog(hook.name),
			getHookSettings: <T>() => this.getHookSettings<T>(`hook:${hook.name}`),
		};
	}

	setRunActive(active: boolean): void {
		this.isRunActive = active;
		if (!active) this.processEventQueue();
	}

	private async processEventQueue(): Promise<void> {
		const queue = this.eventQueue.splice(0);
		for (const { hook, ctx, handler } of queue) {
			await this.withTimeout(
				async (signal) => handler({ ...ctx, signal } as TransportEventContext),
				hook.name,
				ctx.event,
			);
		}
	}

	hasRunHooks(): boolean {
		return this.hooks.some((h) => h.beforeRun || h.afterRun || h.onError);
	}

	hasTransportHooks(): boolean {
		return this.hooks.some((h) => h.onMessage || h.onReaction);
	}

	async emitTransportEvent(
		eventType: "message" | "reaction_added" | "reaction_removed",
		params: {
			transport: TransportName;
			channelDir: string;
			channelId: string;
			channelName?: string;
			guildId?: string;
			guildName?: string;
			sendFn: (text: string) => Promise<void>;
			eventData: unknown;
		},
	): Promise<void> {
		for (const hook of this.hooks) {
			const handler = eventType === "message" ? hook.onMessage : hook.onReaction;
			if (!handler) continue;

			const baseCtx = {
				transport: params.transport,
				workingDir: this.workingDir,
				channelDir: params.channelDir,
				hookDir: join(params.channelDir, ".hooks", hook.name),
				hookName: hook.name,
				timestamp: new Date().toISOString(),
				channel: {
					id: params.channelId,
					name: params.channelName,
					guildId: params.guildId,
					guildName: params.guildName,
				},
				log: this.createLog(hook.name),
				send: params.sendFn,
				getHookSettings: <T>() => this.getHookSettings<T>(`hook:${hook.name}`),
			};

			const ctx: Omit<TransportEventContext, "signal"> =
				eventType === "message"
					? ({ ...baseCtx, event: "message", message: params.eventData } as Omit<MessageEventContext, "signal">)
					: ({ ...baseCtx, event: eventType, reaction: params.eventData } as Omit<ReactionEventContext, "signal">);

			if (this.isRunActive) {
				this.eventQueue.push({ hook, ctx, handler: handler as (ctx: TransportEventContext) => Promise<void> });
			} else {
				await this.withTimeout(
					async (signal) =>
						(handler as (ctx: TransportEventContext) => Promise<void>)({
							...ctx,
							signal,
						} as TransportEventContext),
					hook.name,
					eventType,
				);
			}
		}
	}

	async runBeforeHooks(params: RunHookParams): Promise<{
		blocked: boolean;
		blockReply?: string;
		modifiedMessage?: MessagePatch;
		injectedContext: ContextEntry[];
	}> {
		const results: BeforeRunResult[] = [];

		for (const hook of this.hooks) {
			if (!hook.beforeRun) continue;
			try {
				const result = await hook.beforeRun(this.buildRunContext(hook, params));
				if (result) results.push(result);
			} catch (err) {
				log.logWarning(`[hook:${hook.name}] beforeRun error`, err instanceof Error ? err.message : String(err));
			}
		}

		const blockResult = results.find((r) => r.action === "block") as { action: "block"; reply?: string } | undefined;
		if (blockResult) return { blocked: true, blockReply: blockResult.reply, injectedContext: [] };

		let modifiedMessage: MessagePatch | undefined;
		const injectedContext: ContextEntry[] = [];

		for (const r of results) {
			if (r.action === "modify") modifiedMessage = { ...modifiedMessage, ...r.patch };
			else if (r.action === "injectContext") {
				injectedContext.push(...r.entries);
				if ("patch" in r && r.patch) modifiedMessage = { ...modifiedMessage, ...r.patch };
			}
		}

		return { blocked: false, modifiedMessage, injectedContext };
	}

	async runAfterHooks(params: RunHookParams & { result: RunResult }): Promise<void> {
		for (const hook of this.hooks) {
			if (!hook.afterRun) continue;
			try {
				await hook.afterRun(this.buildRunContext(hook, params), params.result);
			} catch (err) {
				log.logWarning(`[hook:${hook.name}] afterRun error`, err instanceof Error ? err.message : String(err));
			}
		}
	}

	async runOnError(params: RunHookParams & { error: Error }): Promise<ErrorAction | undefined> {
		let finalAction: ErrorAction | undefined;
		for (const hook of this.hooks) {
			if (!hook.onError) continue;
			try {
				const result = await hook.onError(this.buildRunContext(hook, params), params.error);
				if (result) {
					finalAction = result;
					if (result.action === "suppress") break;
				}
			} catch (err) {
				log.logWarning(`[hook:${hook.name}] onError error`, err instanceof Error ? err.message : String(err));
			}
		}
		return finalAction;
	}

	getHooks(): LoadedHook[] {
		return this.hooks;
	}
}

interface RunHookParams {
	transport: TransportName;
	channelDir: string;
	message: RunHookContext["message"];
	user: RunHookContext["user"];
	channel: RunHookContext["channel"];
	reply: RunHookContext["reply"];
	sendFn: (text: string) => Promise<void>;
	signal: AbortSignal;
}
