import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
import * as log from "../log.js";
import type {
	BeforeRunResult,
	ErrorAction,
	HookMeta,
	LoadedHook,
	LoadHooksResult,
	MessageEventContext,
	ReactionEventContext,
	RunHookContext,
	RunResult,
} from "./types.js";
import { deriveModuleName, discoverModulesInDir, findEntryPoint, resolvePath } from "./utils.js";

interface HookModule {
	meta?: HookMeta;
	beforeRun?: (ctx: RunHookContext) => Promise<BeforeRunResult | undefined>;
	afterRun?: (ctx: RunHookContext, result: RunResult) => Promise<void>;
	onError?: (ctx: RunHookContext, error: Error) => Promise<ErrorAction | undefined>;
	onMessage?: (ctx: MessageEventContext) => Promise<void>;
	onReaction?: (ctx: ReactionEventContext) => Promise<void>;
}

async function loadHook(hookPath: string, baseDir: string): Promise<{ hook: LoadedHook | null; error: string | null }> {
	const resolvedPath = resolvePath(hookPath, baseDir);
	if (!existsSync(resolvedPath)) return { hook: null, error: `Hook path does not exist: ${resolvedPath}` };

	const entryPoint = findEntryPoint(resolvedPath);
	if (!entryPoint) return { hook: null, error: `No entry point found for hook: ${resolvedPath}` };

	try {
		const jiti = createJiti(import.meta.url);
		const module = (await jiti.import(entryPoint, { default: true })) as HookModule;
		const hook: LoadedHook = {
			name: deriveModuleName(resolvedPath),
			path: hookPath,
			resolvedPath,
			meta: module.meta,
			beforeRun: module.beforeRun,
			afterRun: module.afterRun,
			onError: module.onError,
			onMessage: module.onMessage,
			onReaction: module.onReaction,
		};
		if (!hook.beforeRun && !hook.afterRun && !hook.onError && !hook.onMessage && !hook.onReaction) {
			return { hook: null, error: `Hook exports no handlers: ${resolvedPath}` };
		}
		return { hook, error: null };
	} catch (err) {
		return { hook: null, error: `Failed to load hook: ${err instanceof Error ? err.message : String(err)}` };
	}
}

async function loadFromDir(
	dir: string,
	hooks: LoadedHook[],
	loadedNames: Set<string>,
	errors: Array<{ path: string; error: string }>,
	replace: boolean,
): Promise<void> {
	for (const hookPath of discoverModulesInDir(dir)) {
		const { hook, error } = await loadHook(hookPath, dir);
		if (error) {
			errors.push({ path: hookPath, error });
			continue;
		}
		if (!hook) continue;
		if (loadedNames.has(hook.name)) {
			if (replace) {
				const idx = hooks.findIndex((h) => h.name === hook.name);
				if (idx >= 0) hooks.splice(idx, 1);
			} else {
				log.logWarning(`Duplicate hook name: ${hook.name}`);
				continue;
			}
		}
		loadedNames.add(hook.name);
		hooks.push(hook);
	}
}

export async function discoverAndLoadHooks(
	workingDir: string,
	configuredPaths: string[] = [],
): Promise<LoadHooksResult> {
	const hooks: LoadedHook[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const loadedNames = new Set<string>();

	await loadFromDir(join(homedir(), ".pi", "mom", "hooks"), hooks, loadedNames, errors, false);
	await loadFromDir(join(workingDir, "hooks"), hooks, loadedNames, errors, true);

	for (const configPath of configuredPaths) {
		const resolved = resolvePath(configPath, workingDir);
		const { hook, error } = await loadHook(configPath, dirname(resolved));
		if (error) {
			errors.push({ path: configPath, error });
		} else if (hook) {
			if (loadedNames.has(hook.name)) {
				log.logWarning(`Duplicate hook name from config: ${hook.name}`);
			} else {
				loadedNames.add(hook.name);
				hooks.push(hook);
			}
		}
	}

	return { hooks, errors };
}
