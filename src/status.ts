/**
 * Experiment status: derived from HuggingFace Job state, with manual override.
 *
 * We poll `hf jobs ps -a --format json` once and map each job's `status.stage`
 * to a one-word status. A node's status aggregates its own jobs plus all of
 * its descendants.
 */

import type { Exec } from "./backend.ts";
import type { ExperimentNode } from "./experiment.ts";

export type Status = "not-started" | "running" | "done" | "failed" | "cancelled" | string;

export const STATUS_LABELS: Record<string, string> = {
	"not-started": "not started",
	running: "in progress",
	done: "complete",
	failed: "failed",
	cancelled: "cancelled",
};

/** Map a raw HF Job stage to our one-word status. */
export function mapStage(stage: string | undefined): Status {
	switch ((stage ?? "").toUpperCase()) {
		case "RUNNING":
		case "UPDATING":
			return "running";
		case "COMPLETED":
			return "done";
		case "ERROR":
		case "FAILED":
			return "failed";
		case "CANCELLED":
		case "CANCELED":
		case "DELETED":
			return "cancelled";
		default:
			return "running"; // unknown but present => treat as in progress
	}
}

/** Poll all jobs and return a map of jobId -> stage string. */
export async function pollJobStages(exec: Exec): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const r = await exec("hf", ["jobs", "ps", "-a", "--format", "json"]);
	if (r.code !== 0) return map;
	let parsed: unknown;
	try {
		parsed = JSON.parse(r.stdout);
	} catch {
		return map;
	}
	if (!Array.isArray(parsed)) return map;
	for (const job of parsed) {
		const id = (job as { id?: string }).id;
		const stage = (job as { status?: { stage?: string } }).status?.stage;
		if (id) map.set(id, stage ?? "");
	}
	return map;
}

/**
 * Aggregate the effective status of a node.
 *
 * - A manual `status` in frontmatter overrides everything for that node.
 * - Otherwise we collect the status of each own job and each child (recursively)
 *   and combine: any running (or a mix of done + not-started) => running;
 *   else any failed => failed; else all not-started => not-started;
 *   else all done => done.
 */
export function aggregate(node: ExperimentNode, jobStages: Map<string, string>): Status {
	if (node.fm.status) return node.fm.status;

	const statuses: Status[] = [];
	for (const job of node.fm.jobs ?? []) {
		statuses.push(jobStages.has(job.id) ? mapStage(jobStages.get(job.id)) : "running");
	}
	for (const child of node.children) {
		statuses.push(aggregate(child, jobStages));
	}

	if (statuses.length === 0) return "not-started";
	if (statuses.some((s) => s === "running")) return "running";

	const done = statuses.filter((s) => s === "done").length;
	const notStarted = statuses.filter((s) => s === "not-started").length;
	const failed = statuses.some((s) => s === "failed");

	if (done > 0 && notStarted > 0) return "running"; // partially done => in progress
	if (failed) return "failed";
	if (notStarted === statuses.length) return "not-started";
	if (done === statuses.length) return "done";
	return "running";
}
