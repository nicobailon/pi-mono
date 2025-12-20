import type { Attachment } from "@mariozechner/pi-agent-core";
import { Container, Markdown, Spacer } from "@mariozechner/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { ImageAttachmentsComponent, type ImageWithNumber } from "./image-attachments.js";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	constructor(text: string, isFirst: boolean, attachments?: Attachment[]) {
		super();

		// Add spacer before user message (except first one)
		if (!isFirst) {
			this.addChild(new Spacer(1));
		}

		const imageAttachments = (attachments ?? []).filter((attachment) => attachment.type === "image");
		if (imageAttachments.length > 0) {
			const parsedNumbers = imageAttachments.map((attachment) => {
				const match = attachment.id.match(/^pasted-image-(\d+):/);
				return match ? Number.parseInt(match[1], 10) : null;
			});

			let maxNum = 0;
			for (const num of parsedNumbers) {
				if (num && num > maxNum) {
					maxNum = num;
				}
			}

			const usedNumbers = new Set<number>();
			const imagesWithNumbers: ImageWithNumber[] = imageAttachments.map((attachment, index) => {
				const parsed = parsedNumbers[index];
				let num = parsed ?? 0;
				if (!num || Number.isNaN(num)) {
					let next = maxNum + 1;
					while (usedNumbers.has(next)) {
						next += 1;
					}
					num = next;
					maxNum = next;
				}
				usedNumbers.add(num);
				return { num, attachment };
			});

			imagesWithNumbers.sort((a, b) => a.num - b.num);
			this.addChild(new ImageAttachmentsComponent(imagesWithNumbers));
			this.addChild(new Spacer(1));
		}

		this.addChild(
			new Markdown(text, 1, 1, getMarkdownTheme(), {
				bgColor: (text: string) => theme.bg("userMessageBg", text),
				color: (text: string) => theme.fg("userMessageText", text),
			}),
		);
	}
}
