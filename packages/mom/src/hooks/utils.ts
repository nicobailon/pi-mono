import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const DEFAULT_EXTENSIONS = [".ts", ".js", ".mjs"];
const INDEX_FILES = ["index.ts", "index.js", "index.mjs"];

export function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

export function expandPath(p: string): string {
	const normalized = normalizeUnicodeSpaces(p);
	if (normalized.startsWith("~/")) {
		return join(homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("~")) {
		return join(homedir(), normalized.slice(1));
	}
	return normalized;
}

export function resolvePath(modulePath: string, baseDir: string): string {
	const expanded = expandPath(modulePath);
	if (isAbsolute(expanded)) {
		return expanded;
	}
	return resolve(baseDir, expanded);
}

export function deriveModuleName(resolvedPath: string): string {
	const stats = statSync(resolvedPath);
	if (stats.isDirectory()) {
		return basename(resolvedPath);
	}
	return basename(resolvedPath).replace(/\.(ts|js|mjs)$/, "");
}

export function findEntryPoint(resolvedPath: string): string | null {
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(resolvedPath);
	} catch {
		return null;
	}

	if (stats.isFile()) {
		return resolvedPath;
	}

	if (stats.isDirectory()) {
		for (const indexFile of INDEX_FILES) {
			const indexPath = join(resolvedPath, indexFile);
			if (existsSync(indexPath)) return indexPath;
		}
	}

	return null;
}

export interface ModuleDiscoveryOptions {
	extensions?: string[];
	skipHidden?: boolean;
}

export function discoverModulesInDir(dir: string, options: ModuleDiscoveryOptions = {}): string[] {
	const { extensions = DEFAULT_EXTENSIONS, skipHidden = true } = options;

	if (!existsSync(dir)) {
		return [];
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		const modules: string[] = [];

		for (const entry of entries) {
			if (skipHidden && entry.name.startsWith(".")) continue;

			if (entry.isFile()) {
				if (extensions.some((ext) => entry.name.endsWith(ext))) {
					modules.push(join(dir, entry.name));
				}
			} else if (entry.isDirectory()) {
				for (const indexFile of INDEX_FILES) {
					if (existsSync(join(dir, entry.name, indexFile))) {
						modules.push(join(dir, entry.name));
						break;
					}
				}
			}
		}

		return modules.sort();
	} catch {
		return [];
	}
}
