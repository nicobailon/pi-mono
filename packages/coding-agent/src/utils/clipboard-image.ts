import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { Attachment } from "@mariozechner/pi-agent-core";
import { hasClipboardImages, readClipboardImages } from "clipboard-image";

export function isClipboardImageSupported(): boolean {
	return process.platform === "darwin";
}

export async function checkClipboardHasImages(): Promise<boolean> {
	if (!isClipboardImageSupported()) return false;
	return hasClipboardImages();
}

export async function getClipboardImages(): Promise<Attachment[]> {
	const paths = await readClipboardImages();
	return Promise.all(
		paths.map(async (filePath) => {
			try {
				const content = await fs.promises.readFile(filePath);
				return {
					id: crypto.randomUUID(),
					type: "image" as const,
					fileName: filePath.split("/").pop() || "clipboard-image.png",
					mimeType: "image/png",
					size: content.length,
					content: content.toString("base64"),
				};
			} finally {
				await fs.promises.unlink(filePath).catch(() => {});
			}
		}),
	);
}
