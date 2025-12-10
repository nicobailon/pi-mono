/**
 * Summary cache utilities for instant compaction.
 * Cache is stored in-memory (in AgentSession), these are validation helpers.
 */

import type { CompactionEntry, SessionEntry } from "./session-manager.js";

// ============================================================================
// Types
// ============================================================================

export interface SummaryCache {
	firstKeptEntryIndex: number;
	summary: string;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Check if cache is valid for current session state.
 *
 * Cache is invalid if:
 * - Entry count decreased (branch/reset happened)
 * - A compaction entry exists after the cached cut point
 */
export function isCacheValid(cache: SummaryCache, entries: SessionEntry[]): boolean {
	// Entry count decreased means branch or reset
	if (entries.length < cache.firstKeptEntryIndex) {
		return false;
	}

	// Check for compaction after the cached cut point
	for (let i = cache.firstKeptEntryIndex; i < entries.length; i++) {
		if (entries[i].type === "compaction") {
			return false;
		}
	}

	return true;
}

// ============================================================================
// Compaction Helper
// ============================================================================

/**
 * Create a CompactionEntry from cached summary.
 */
export function createCompactionFromCache(cache: SummaryCache, tokensBefore: number): CompactionEntry {
	return {
		type: "compaction",
		timestamp: new Date().toISOString(),
		summary: cache.summary,
		firstKeptEntryIndex: cache.firstKeptEntryIndex,
		tokensBefore,
	};
}
