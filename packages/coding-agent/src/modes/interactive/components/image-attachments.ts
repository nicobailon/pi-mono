import type { Attachment } from "@mariozechner/pi-agent-core";
import { Container, Image, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";

export interface ImageWithNumber {
	num: number;
	attachment: Attachment;
}

export class ImageAttachmentsComponent extends Container {
	constructor(images: ImageWithNumber[]) {
		super();

		if (images.length === 0) return;

		for (const img of images) {
			this.addChild(new Text(theme.fg("muted", `[Pasted Image ${img.num}]`), 0, 0));
			this.addChild(
				new Image(
					img.attachment.content,
					img.attachment.mimeType,
					{ fallbackColor: (s: string) => theme.fg("muted", s) },
					{ maxWidthCells: 20, maxHeightCells: 8 },
				),
			);
			this.addChild(new Spacer(1));
		}
	}
}
