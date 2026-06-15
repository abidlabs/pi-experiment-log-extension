/**
 * Trace export: serialize the current pi session branch to JSONL so the full
 * agent trace can be embedded/linked from an experiment page.
 *
 * Phase 1 writes the JSONL alongside the log (local or committed to the Space).
 * A later phase can push it to a companion HF Dataset and link instead.
 */

import type { Backend } from "./backend.ts";

/** Minimal slice of the session manager we read. */
interface SessionLike {
	getBranch(): Array<unknown>;
}

/**
 * Export the current branch to `traces/<slug>.jsonl` and return the relative
 * path (to store in frontmatter). Returns null if there is nothing to export.
 */
export async function exportTrace(
	backend: Backend,
	sessionManager: SessionLike,
	slug: string,
): Promise<string | null> {
	const entries = sessionManager.getBranch();
	if (!entries || entries.length === 0) return null;

	const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	const rel = `traces/${slug || "root"}.jsonl`;
	await backend.writeFile(rel, lines);
	return rel;
}
