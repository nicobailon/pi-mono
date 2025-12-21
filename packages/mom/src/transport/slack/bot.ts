import { SocketModeClient } from "@slack/socket-mode";
import { type ChatPostMessageResponse, WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import type { MomSettingsManager, SlackProfileSettings } from "../../context.js";
import * as log from "../../log.js";
import type { Attachment, ChannelStore } from "../../store.js";

export interface SlackEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	attachments?: Attachment[];
	reactions?: Array<{ emoji: string; count: number }>;
}

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
	email?: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
	email?: string;
}

export interface SlackContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export interface SlackMessageEventData {
	id: string;
	text: string;
	userId: string;
	userName?: string;
	displayName?: string;
	isBot: boolean;
	isMention: boolean;
	channelId: string;
	channelName?: string;
	threadTs?: string;
	attachments: Array<{ name: string; localPath?: string }>;
}

export interface MomHandler {
	isRunning(channelId: string): boolean;

	handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void>;

	handleStop(channelId: string, slack: SlackBot): Promise<void>;

	onMessageEvent?(data: SlackMessageEventData): void;
}

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

const SLACK_MAX_LENGTH = 40000;

export class SlackBot {
	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler: MomHandler;
	private workingDir: string;
	private store: ChannelStore;
	private settingsManager?: MomSettingsManager;
	private botUserId: string | null = null;
	private startupTs: string | null = null;

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private queues = new Map<string, ChannelQueue>();
	private profileOverrides: { username?: string; iconUrl?: string; iconEmoji?: string } = {};

	constructor(
		handler: MomHandler,
		config: {
			appToken: string;
			botToken: string;
			workingDir: string;
			store: ChannelStore;
			settingsManager?: MomSettingsManager;
		},
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.settingsManager = config.settingsManager;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
	}

	private truncateMessage(text: string, suffix = "\n\n_(message truncated)_"): string {
		if (text.length <= SLACK_MAX_LENGTH) return text;
		return text.substring(0, SLACK_MAX_LENGTH - suffix.length) + suffix;
	}

	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		const initialProfile = this.settingsManager?.getSlackProfileSettings();
		if (initialProfile) {
			this.setProfileOverrides(initialProfile);
		}

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		this.setupEventHandlers();
		await this.socketClient.start();

		this.startupTs = (Date.now() / 1000).toFixed(6);

		log.logConnected();
	}

	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const iconFields = this.profileOverrides.iconEmoji
			? { icon_emoji: this.profileOverrides.iconEmoji }
			: this.profileOverrides.iconUrl
				? { icon_url: this.profileOverrides.iconUrl }
				: {};
		const hasOverrides = Boolean(
			this.profileOverrides.username || this.profileOverrides.iconEmoji || this.profileOverrides.iconUrl,
		);

		let result: ChatPostMessageResponse;
		try {
			result = await this.webClient.chat.postMessage({
				channel,
				text: this.truncateMessage(text),
				...(this.profileOverrides.username ? { username: this.profileOverrides.username } : {}),
				...iconFields,
			});
		} catch (err) {
			if (!hasOverrides) throw err;
			log.logWarning(
				"Slack postMessage failed with authorship overrides; retrying without overrides",
				err instanceof Error ? err.message : String(err),
			);
			result = await this.webClient.chat.postMessage({ channel, text: this.truncateMessage(text) });
		}
		return result.ts as string;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text: this.truncateMessage(text) });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const iconFields = this.profileOverrides.iconEmoji
			? { icon_emoji: this.profileOverrides.iconEmoji }
			: this.profileOverrides.iconUrl
				? { icon_url: this.profileOverrides.iconUrl }
				: {};
		const hasOverrides = Boolean(
			this.profileOverrides.username || this.profileOverrides.iconEmoji || this.profileOverrides.iconUrl,
		);

		let result: ChatPostMessageResponse;
		try {
			result = await this.webClient.chat.postMessage({
				channel,
				thread_ts: threadTs,
				text: this.truncateMessage(text),
				...(this.profileOverrides.username ? { username: this.profileOverrides.username } : {}),
				...iconFields,
			});
		} catch (err) {
			if (!hasOverrides) throw err;
			log.logWarning(
				"Slack postInThread failed with authorship overrides; retrying without overrides",
				err instanceof Error ? err.message : String(err),
			);
			result = await this.webClient.chat.postMessage({
				channel,
				thread_ts: threadTs,
				text: this.truncateMessage(text),
			});
		}
		return result.ts as string;
	}

	setProfileOverrides(overrides: Partial<SlackProfileSettings>): void {
		this.profileOverrides = { ...this.profileOverrides, ...overrides };
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		await this.webClient.files.uploadV2({
			channel_id: channel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
	}

	async addReaction(channel: string, timestamp: string, name: string): Promise<{ success: boolean; message: string }> {
		try {
			await this.webClient.reactions.add({ channel, timestamp, name });
			return { success: true, message: `Reacted with :${name}:` };
		} catch (err) {
			return { success: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	async fetchMessageReactions(channel: string, timestamp: string): Promise<Array<{ emoji: string; count: number }>> {
		try {
			const result = await this.webClient.reactions.get({ channel, timestamp });
			const message = result.message as { reactions?: Array<{ name: string; count: number }> } | undefined;
			if (!message?.reactions) return [];
			return message.reactions.map((r) => ({ emoji: `:${r.name}:`, count: r.count }));
		} catch {
			return [];
		}
	}

	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), JSON.stringify(entry) + "\n");
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	enqueueEvent(event: { channelId: string; text: string }): boolean {
		const queue = this.getQueue(event.channelId);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channelId}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channelId}: ${event.text.substring(0, 50)}`);

		const syntheticEvent: SlackEvent = {
			type: "mention",
			channel: event.channelId,
			user: "EVENT",
			text: event.text,
			ts: Date.now().toString(),
		};

		queue.enqueue(() => this.handler.handleEvent(syntheticEvent, this, true));
		return true;
	}

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private setupEventHandlers(): void {
		this.socketClient.on("app_mention", async ({ event, ack }) => {
			// Ack early to avoid Slack retries due to slow downstream calls (e.g., reactions.get).
			void ack();

			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			if (e.channel.startsWith("D")) {
				return;
			}

			const slackEvent: SlackEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			slackEvent.attachments = this.logUserMessage(slackEvent);
			slackEvent.reactions = await this.fetchMessageReactions(e.channel, e.ts);

			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
				);
				return;
			}

			if (slackEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(e.channel)) {
					this.handler.handleStop(e.channel, this);
				} else {
					this.postMessage(e.channel, "_Nothing running_");
				}
				return;
			}

			if (this.handler.isRunning(e.channel)) {
				this.postMessage(e.channel, "_Already working. Say `@mom stop` to cancel._");
			} else {
				this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
			}
		});

		this.socketClient.on("message", async ({ event, ack }) => {
			// Ack early to avoid Slack retries due to slow downstream calls (e.g., reactions.get).
			void ack();

			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				thread_ts?: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			if (e.bot_id || !e.user || e.user === this.botUserId) {
				return;
			}
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				return;
			}

			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			if (!isDM && isBotMention) {
				return;
			}

			const slackEvent: SlackEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			slackEvent.attachments = this.logUserMessage(slackEvent);
			slackEvent.reactions = await this.fetchMessageReactions(e.channel, e.ts);

			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
				return;
			}

			if (isDM) {
				if (!this.settingsManager?.canUserDM("slack", e.user)) {
					return;
				}

				if (slackEvent.text.toLowerCase().trim() === "stop") {
					if (this.handler.isRunning(e.channel)) {
						this.handler.handleStop(e.channel, this);
					} else {
						this.postMessage(e.channel, "_Nothing running_");
					}
					return;
				}

				if (this.handler.isRunning(e.channel)) {
					this.postMessage(e.channel, "_Already working. Say `stop` to cancel._");
				} else {
					this.getQueue(e.channel).enqueue(() => this.handler.handleEvent(slackEvent, this));
				}
			}

			if (this.handler.onMessageEvent) {
				const user = this.users.get(e.user);
				const channel = this.channels.get(e.channel);
				this.handler.onMessageEvent({
					id: e.ts,
					text: e.text || "",
					userId: e.user,
					userName: user?.userName,
					displayName: user?.displayName,
					isBot: false,
					isMention: isBotMention || false,
					channelId: e.channel,
					channelName: channel?.name,
					threadTs: e.thread_ts,
					attachments: slackEvent.attachments?.map((a) => ({ name: basename(a.local), localPath: a.local })) || [],
				});
			}
		});
	}

	private logUserMessage(event: SlackEvent): Attachment[] {
		const user = this.users.get(event.user);
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs,
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false;
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		relevantMessages.reverse();

		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
			});
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		const channelsToBackfill: Array<[string, SlackChannel]> = [];
		for (const [channelId, channel] of this.channels) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channelId, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{
						id?: string;
						name?: string;
						real_name?: string;
						deleted?: boolean;
						profile?: { email?: string };
				  }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, {
							id: u.id,
							userName: u.name,
							displayName: u.real_name || u.name,
							email: u.profile?.email,
						});
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}
