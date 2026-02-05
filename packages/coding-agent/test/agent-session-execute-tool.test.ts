import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { CustomEntry } from "../src/core/session-manager.js";
import { createTestSession } from "./utilities.js";

describe("AgentSession.executeTool", () => {
	it("executes tool and returns result without adding to conversation history", async () => {
		const ctx = createTestSession({ inMemory: true });
		try {
			const filePath = path.join(ctx.tempDir, "hello.txt");
			fs.writeFileSync(filePath, "hello", "utf-8");

			const messageCountBefore = ctx.session.state.messages.length;
			const result = await ctx.session.executeTool("read", { path: filePath });

			// Result contains file content
			expect(result.isError).toBe(false);
			const text = result.content.find((c) => c.type === "text")?.text;
			expect(text).toContain("hello");

			// No messages added to conversation history
			expect(ctx.session.state.messages.length).toBe(messageCountBefore);

			// Custom entry added for audit trail
			const entries = ctx.sessionManager.getEntries();
			const customEntry = entries.find((e) => e.type === "custom") as CustomEntry | undefined;
			expect(customEntry).toBeDefined();
			expect(customEntry?.customType).toBe("tool_execution");
			expect((customEntry?.data as { toolName: string }).toolName).toBe("read");
		} finally {
			ctx.cleanup();
		}
	});
});
