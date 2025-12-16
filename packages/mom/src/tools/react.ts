import type { AgentTool, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { TransportContext } from "../transport/types.js";

export interface ReactRuntime {
	addReaction: (channelId: string, messageId: string, emoji: string) => Promise<{ success: boolean; message: string }>;
}

const reactSchema = Type.Object({
	label: Type.String({ description: "Brief description shown to user" }),
	emoji: Type.String({
		description:
			"Emoji to react with. Discord: unicode emoji or custom emoji name. Slack: emoji name (e.g., 'thumbsup'); ':thumbsup:' also accepted.",
	}),
	messageId: Type.Optional(
		Type.String({ description: "Message ID to react to (defaults to the message that triggered this interaction)" }),
	),
	channelId: Type.Optional(Type.String({ description: "Channel ID (defaults to current channel)" })),
});

type ReactArgs = {
	label: string;
	emoji: string;
	messageId?: string;
	channelId?: string;
};

export function createReactTool(
	getCtx: () => TransportContext | null,
	getRuntime: () => ReactRuntime | null,
): AgentTool<typeof reactSchema> {
	return {
		name: "react",
		label: "react",
		description:
			"Add an emoji reaction to a message. Defaults to reacting to the message that triggered this interaction. Provide messageId to react to a different message. Slack accepts both 'thumbsup' and ':thumbsup:'.",
		parameters: reactSchema,
		execute: async (
			_toolCallId: string,
			args: ReactArgs,
			_signal?: AbortSignal,
		): Promise<{ content: TextContent[]; details: undefined }> => {
			const ctx = getCtx();
			if (!ctx) throw new Error("No active transport context");

			const runtime = getRuntime();
			if (!runtime) throw new Error("React runtime not configured");

			const channelId = args.channelId ?? ctx.message.channelId;
			const messageId = args.messageId ?? ctx.message.messageId;

			const emoji = normalizeEmojiForTransport(ctx.transport, args.emoji);
			const result = await runtime.addReaction(channelId, messageId, emoji);

			if (!result.success) {
				throw new Error(result.message);
			}

			return {
				content: [{ type: "text" as const, text: result.message }],
				details: undefined,
			};
		},
	};
}

function normalizeEmojiForTransport(transport: TransportContext["transport"], emoji: string): string {
	const trimmed = emoji.trim();
	if (transport !== "slack") return trimmed;

	// Slack reactions.add expects the emoji "name" (no surrounding colons).
	// Accept common user input like ":thumbsup:" since Slack messages display reactions that way.
	if (!trimmed.startsWith(":")) return trimmed;

	// Only strip the trailing ":" when this is a single-token emoji like ":thumbsup:" or ":+1:".
	// For composite forms like ":+1::skin-tone-2:" we only strip the leading ":" so we don't corrupt the suffix.
	if (/^:[^:]+:$/.test(trimmed)) {
		return trimmed.slice(1, -1);
	}

	return trimmed.slice(1);
}
