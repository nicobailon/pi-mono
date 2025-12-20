import {
	Editor,
	type EditorTheme,
	isCtrlC,
	isCtrlD,
	isCtrlO,
	isCtrlP,
	isCtrlShiftV,
	isCtrlT,
	isEscape,
	isShiftTab,
} from "@mariozechner/pi-tui";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"];

function unescapePath(text: string): string {
	let path = text.trim();
	if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
		path = path.slice(1, -1);
	}
	return path.replace(/\\(.)/g, "$1");
}

function isImagePath(text: string): boolean {
	const unescaped = unescapePath(text);
	if (!unescaped.startsWith("/") && !unescaped.startsWith("~") && !unescaped.startsWith("./")) {
		return false;
	}
	const lower = unescaped.toLowerCase();
	return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Custom editor that handles Escape and Ctrl+C keys for coding-agent
 */
export class CustomEditor extends Editor {
	public onEscape?: () => void;
	public onCtrlC?: () => void;
	public onCtrlD?: () => void;
	public onShiftTab?: () => void;
	public onCtrlP?: () => void;
	public onCtrlO?: () => void;
	public onCtrlT?: () => void;
	public onPasteImage?: () => void;
	public onCtrlShiftV?: () => Promise<boolean>;
	public onPasteImagePath?: (path: string) => void;

	constructor(theme: EditorTheme) {
		super(theme);
		this.onPaste = (pastedText) => {
			if (pastedText.length === 0 && this.onPasteImage) {
				this.onPasteImage();
				return true;
			}
			if (isImagePath(pastedText) && this.onPasteImagePath) {
				this.onPasteImagePath(unescapePath(pastedText));
				return true;
			}
			return false;
		};
	}

	handleInput(data: string): void {
		if (isCtrlShiftV(data) && this.onCtrlShiftV) {
			void this.onCtrlShiftV().then((handled) => {
				if (!handled) {
					super.handleInput(data);
				}
			});
			return;
		}

		// Intercept Ctrl+T for thinking block visibility toggle
		if (isCtrlT(data) && this.onCtrlT) {
			this.onCtrlT();
			return;
		}

		// Intercept Ctrl+O for tool output expansion
		if (isCtrlO(data) && this.onCtrlO) {
			this.onCtrlO();
			return;
		}

		// Intercept Ctrl+P for model cycling
		if (isCtrlP(data) && this.onCtrlP) {
			this.onCtrlP();
			return;
		}

		// Intercept Shift+Tab for thinking level cycling
		if (isShiftTab(data) && this.onShiftTab) {
			this.onShiftTab();
			return;
		}

		// Intercept Escape key - but only if autocomplete is NOT active
		// (let parent handle escape for autocomplete cancellation)
		if (isEscape(data) && this.onEscape && !this.isShowingAutocomplete()) {
			this.onEscape();
			return;
		}

		// Intercept Ctrl+C
		if (isCtrlC(data) && this.onCtrlC) {
			this.onCtrlC();
			return;
		}

		// Intercept Ctrl+D (only when editor is empty)
		if (isCtrlD(data)) {
			if (this.getText().length === 0 && this.onCtrlD) {
				this.onCtrlD();
			}
			// Always consume Ctrl+D (don't pass to parent)
			return;
		}

		// Pass to parent for normal handling
		super.handleInput(data);
	}
}
