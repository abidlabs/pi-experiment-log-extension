/**
 * Experiment model: frontmatter schema, markdown (de)serialization, and tree
 * building from the on-disk directory layout.
 *
 * Each experiment is a directory containing an `index.md`. Nesting = subdirs
 * that themselves contain an `index.md`. The experiment id is its directory
 * path relative to the log root ("" for the root experiment).
 */

import matter from "gray-matter";
import type { Backend } from "./backend.ts";

export type ArtifactType = "trackio" | "dataset" | "image" | "link";

export interface Artifact {
	type: ArtifactType;
	title?: string;
	// trackio
	space?: string;
	project?: string;
	query?: string;
	url?: string;
	// dataset
	repo?: string;
	revision?: string;
	// image
	path?: string;
	data_path?: string;
	// link / generic
	href?: string;
	note?: string;
}

export interface JobRef {
	id: string;
}

/** A primary numeric result for an experiment (feeds the root leaderboard/chart). */
export interface Result {
	metric: string;
	value: number;
	higher_is_better?: boolean;
	units?: string;
	/** ISO timestamp when the result was recorded (x-axis for the chart). */
	at?: string;
}

export interface Frontmatter {
	title: string;
	/** Optional manual status override (e.g. "blocked", "abandoned"). */
	status?: string;
	jobs?: JobRef[];
	artifacts?: Artifact[];
	result?: Result;
	trace?: string;
	created?: string;
	updated?: string;
}

export interface ExperimentNode {
	/** Relative path id, "" for root. */
	id: string;
	fm: Frontmatter;
	body: string;
	children: ExperimentNode[];
}

export function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "experiment"
	);
}

/** Path to an experiment's markdown file given its id. */
export function mdPath(id: string): string {
	return id ? `${id}/index.md` : "index.md";
}

/** Path to an experiment's generated HTML file given its id. */
export function htmlPath(id: string): string {
	return id ? `${id}/index.html` : "index.html";
}

export function parseDoc(content: string): { fm: Frontmatter; body: string } {
	const parsed = matter(content);
	const fm = (parsed.data ?? {}) as Frontmatter;
	if (!fm.title) fm.title = "Untitled experiment";
	return { fm, body: parsed.content.trim() };
}

export function serializeDoc(fm: Frontmatter, body: string): string {
	// gray-matter emits a clean YAML frontmatter block.
	return matter.stringify(`\n${body.trim()}\n`, fm as Record<string, unknown>);
}

/** Depth of a node from root (root = 0). */
export function depthOf(id: string): number {
	return id ? id.split("/").length : 0;
}

/** All ancestor ids of `id`, from root-most to immediate parent (excludes id). */
export function ancestorsOf(id: string): string[] {
	if (!id) return [];
	const parts = id.split("/");
	const out: string[] = [""];
	for (let i = 1; i < parts.length; i++) {
		out.push(parts.slice(0, i).join("/"));
	}
	return out;
}

/**
 * Walk the backend directory tree and build the experiment tree.
 * A directory is an experiment iff it contains an index.md.
 */
export async function loadTree(backend: Backend): Promise<ExperimentNode | null> {
	const rootMd = await backend.readFile(mdPath(""));
	if (rootMd === null) return null;

	const build = async (id: string): Promise<ExperimentNode> => {
		const raw = (await backend.readFile(mdPath(id))) ?? "---\ntitle: Untitled\n---\n";
		const { fm, body } = parseDoc(raw);
		const childDirs = await backend.listDirs(id);
		const children: ExperimentNode[] = [];
		for (const dir of childDirs.sort()) {
			if (dir === "assets" || dir === "traces" || dir.startsWith(".")) continue;
			const childId = id ? `${id}/${dir}` : dir;
			if (await backend.exists(mdPath(childId))) {
				children.push(await build(childId));
			}
		}
		return { id, fm, body, children };
	};

	return build("");
}

/** Find a node by id within a tree. */
export function findNode(root: ExperimentNode, id: string): ExperimentNode | null {
	if (root.id === id) return root;
	for (const child of root.children) {
		const found = findNode(child, id);
		if (found) return found;
	}
	return null;
}

/** Flatten a tree into a pre-order list. */
export function flatten(root: ExperimentNode): ExperimentNode[] {
	const out: ExperimentNode[] = [root];
	for (const child of root.children) out.push(...flatten(child));
	return out;
}
