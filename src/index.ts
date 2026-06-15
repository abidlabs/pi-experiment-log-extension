/**
 * Experiment Log extension.
 *
 * Turns a local directory or a HuggingFace Space into a nested, agent-
 * collaborative experiment log. Markdown is canonical (agents read/write it);
 * HTML is generated for humans. Each experiment can track 0..N HF Jobs whose
 * status is polled and aggregated up the tree.
 *
 * Backend is chosen at startup:
 *   pi -e ./experiment-log/src/index.ts --exp-local ./my-log
 *   pi -e ./experiment-log/src/index.ts --exp-space org/my-log
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type Backend, type Exec, LocalBackend, SpaceBackend } from "./backend.ts";
import {
	type Artifact,
	type ExperimentNode,
	findNode,
	flatten,
	type Frontmatter,
	loadTree,
	mdPath,
	parseDoc,
	type Result,
	serializeDoc,
	slugify,
} from "./experiment.ts";
import { renderAll } from "./render.ts";
import { aggregate, pollJobStages, STATUS_LABELS } from "./status.ts";
import { exportTrace } from "./trace.ts";

const baseDir = path.dirname(fileURLToPath(import.meta.url));

function normalizeId(id: string | undefined): string {
	if (!id) return "";
	const trimmed = id.trim();
	if (trimmed === "root" || trimmed === "/" || trimmed === ".") return "";
	return trimmed.replace(/^\/+|\/+$/g, "");
}

function nowIso(): string {
	return new Date().toISOString();
}

class Engine {
	private root: ExperimentNode | null = null;
	private jobStages = new Map<string, string>();
	private queue: Promise<unknown> = Promise.resolve();
	private readonly backend: Backend;
	private readonly exec: Exec;
	private readonly rootTitle: string;

	constructor(backend: Backend, exec: Exec, rootTitle: string) {
		this.backend = backend;
		this.exec = exec;
		this.rootTitle = rootTitle;
	}

	describe(): string {
		return this.backend.describe();
	}

	localPathFor(rel: string): string {
		return path.join(this.backend.root, rel);
	}

	/** Run a mutating operation serialized against all other mutations. */
	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async reload(): Promise<void> {
		this.root = await loadTree(this.backend);
	}

	private async rerender(): Promise<void> {
		if (this.root) await renderAll(this.backend, this.root, this.jobStages);
	}

	/** Ensure a root experiment exists; poll status; render. Called on startup. */
	async init(): Promise<void> {
		await this.enqueue(async () => {
			await this.backend.pullLatest();
			if (!(await this.backend.exists(mdPath("")))) {
				const fm: Frontmatter = { title: this.rootTitle, created: nowIso(), updated: nowIso() };
				const body = `# ${this.rootTitle}\n\nHigh-level goal for this experiment log. Sub-experiments live in nested folders; each tracks its own HuggingFace Job(s).`;
				await this.backend.writeFile(mdPath(""), serializeDoc(fm, body));
			}
			await this.reload();
			this.jobStages = await pollJobStages(this.exec);
			await this.rerender();
			await this.backend.commitAndPush("Initialize experiment log");
		});
	}

	private requireRoot(): ExperimentNode {
		if (!this.root) throw new Error("Experiment log not initialized");
		return this.root;
	}

	private requireNode(id: string): ExperimentNode {
		const node = findNode(this.requireRoot(), id);
		if (!node) throw new Error(`Experiment not found: "${id || "root"}"`);
		return node;
	}

	private async readDoc(id: string): Promise<{ fm: Frontmatter; body: string }> {
		const raw = await this.backend.readFile(mdPath(id));
		if (raw === null) throw new Error(`Experiment not found: "${id || "root"}"`);
		return parseDoc(raw);
	}

	private async writeDoc(id: string, fm: Frontmatter, body: string): Promise<void> {
		fm.updated = nowIso();
		await this.backend.writeFile(mdPath(id), serializeDoc(fm, body));
	}

	/** A compact, token-efficient view of the whole tree with statuses. */
	treeText(): string {
		const root = this.requireRoot();
		const lines: string[] = [];
		const walk = (node: ExperimentNode, depth: number) => {
			const indent = "  ".repeat(depth);
			if (!node.id) {
				// Root is an overview; it has no status.
				lines.push(`${indent}- ${node.fm.title}  <(root)>`);
			} else {
				const status = aggregate(node, this.jobStages);
				const label = STATUS_LABELS[status] ?? status;
				lines.push(`${indent}- [${label}] ${node.fm.title}  <${node.id}>`);
			}
			for (const child of node.children) walk(child, depth + 1);
		};
		walk(root, 0);
		return lines.join("\n");
	}

	/** The high-level goal (root title). */
	goal(): string {
		return this.root?.fm.title ?? this.rootTitle;
	}

	/** Summary used to paint the terminal footer + widget. */
	statusSummary(): {
		goal: string;
		total: number;
		running: number;
		done: number;
		notStarted: number;
		failed: number;
		runningList: Array<{ id: string; title: string }>;
		best?: { title: string; value: number; metric: string; units?: string };
	} {
		const goal = this.goal();
		if (!this.root) {
			return { goal, total: 0, running: 0, done: 0, notStarted: 0, failed: 0, runningList: [] };
		}
		const nodes = flatten(this.root).filter((n) => n.id); // exclude root overview
		let running = 0;
		let done = 0;
		let notStarted = 0;
		let failed = 0;
		const runningList: Array<{ id: string; title: string }> = [];
		for (const n of nodes) {
			const s = aggregate(n, this.jobStages);
			if (s === "running") {
				running++;
				runningList.push({ id: n.id, title: n.fm.title });
			} else if (s === "done") done++;
			else if (s === "failed") failed++;
			else if (s === "not-started") notStarted++;
		}

		let best: { title: string; value: number; metric: string; units?: string } | undefined;
		const withResults = nodes.filter((n) => n.fm.result && typeof n.fm.result.value === "number");
		if (withResults.length) {
			const hib =
				withResults.filter((n) => n.fm.result?.higher_is_better === false).length <=
				withResults.filter((n) => n.fm.result?.higher_is_better !== false).length;
			const top = [...withResults].sort((a, b) =>
				hib
					? (b.fm.result as { value: number }).value - (a.fm.result as { value: number }).value
					: (a.fm.result as { value: number }).value - (b.fm.result as { value: number }).value,
			)[0];
			const r = top.fm.result as { value: number; metric: string; units?: string };
			best = { title: top.fm.title, value: r.value, metric: r.metric, units: r.units };
		}

		return { goal, total: nodes.length, running, done, notStarted, failed, runningList, best };
	}

	/** Detailed view of one experiment: its markdown + child summaries. */
	nodeView(id: string): string {
		const node = this.requireNode(id);
		const out: string[] = [];
		if (node.id) {
			const status = aggregate(node, this.jobStages);
			out.push(`# ${node.fm.title}  [${STATUS_LABELS[status] ?? status}]`);
		} else {
			out.push(`# ${node.fm.title}  (root overview)`);
		}
		out.push(`id: ${node.id || "(root)"}`);
		if (node.fm.result)
			out.push(`result: ${node.fm.result.metric}=${node.fm.result.value}${node.fm.result.units ? " " + node.fm.result.units : ""}`);
		if (node.fm.jobs?.length) out.push(`jobs: ${node.fm.jobs.map((j) => j.id).join(", ")}`);
		if (node.fm.artifacts?.length)
			out.push(`artifacts: ${node.fm.artifacts.map((a) => `${a.type}:${a.title ?? ""}`).join(", ")}`);
		if (node.fm.trace) out.push(`trace: ${node.fm.trace}`);
		out.push("");
		out.push(node.body || "_(no description)_");
		if (node.children.length) {
			out.push("");
			out.push("## Sub-experiments");
			for (const child of node.children) {
				const cs = aggregate(child, this.jobStages);
				out.push(`- [${STATUS_LABELS[cs] ?? cs}] ${child.fm.title}  <${child.id}>`);
			}
		}
		return out.join("\n");
	}

	async createExperiment(parentId: string, title: string, body: string): Promise<string> {
		return this.enqueue(async () => {
			await this.backend.pullLatest();
			await this.reload();
			const parent = normalizeId(parentId);
			if (parent && !(await this.backend.exists(mdPath(parent)))) {
				throw new Error(`Parent experiment not found: "${parent}"`);
			}
			// Unique slug within the parent directory.
			let slug = slugify(title);
			let candidate = parent ? `${parent}/${slug}` : slug;
			let n = 2;
			while (await this.backend.exists(mdPath(candidate))) {
				slug = `${slugify(title)}-${n++}`;
				candidate = parent ? `${parent}/${slug}` : slug;
			}
			const fm: Frontmatter = { title, created: nowIso(), updated: nowIso() };
			await this.backend.writeFile(mdPath(candidate), serializeDoc(fm, body || `# ${title}\n`));
			await this.reload();
			await this.rerender();
			await this.backend.commitAndPush(`Add experiment: ${title}`);
			return candidate;
		});
	}

	async updateExperiment(
		id: string,
		opts: { body?: string; append?: string; status?: string },
	): Promise<void> {
		await this.enqueue(async () => {
			await this.backend.pullLatest();
			const nid = normalizeId(id);
			const { fm, body } = await this.readDoc(nid);
			let newBody = body;
			if (opts.body !== undefined) newBody = opts.body;
			if (opts.append) newBody = `${newBody.trim()}\n\n${opts.append.trim()}`;
			if (opts.status !== undefined) {
				if (opts.status === "") delete fm.status;
				else fm.status = opts.status;
			}
			await this.writeDoc(nid, fm, newBody);
			await this.reload();
			await this.rerender();
			await this.backend.commitAndPush(`Update experiment: ${fm.title}`);
		});
	}

	async linkJob(id: string, jobId: string): Promise<void> {
		await this.enqueue(async () => {
			await this.backend.pullLatest();
			const nid = normalizeId(id);
			if (!nid) {
				throw new Error(
					"The root is an overview and cannot track jobs. Link jobs to a sub-experiment instead.",
				);
			}
			const { fm, body } = await this.readDoc(nid);
			fm.jobs = fm.jobs ?? [];
			if (!fm.jobs.some((j) => j.id === jobId)) fm.jobs.push({ id: jobId });
			await this.writeDoc(nid, fm, body);
			this.jobStages = await pollJobStages(this.exec);
			await this.reload();
			await this.rerender();
			await this.backend.commitAndPush(`Link job ${jobId} to ${fm.title}`);
		});
	}

	async embedArtifact(id: string, artifact: Artifact): Promise<void> {
		await this.enqueue(async () => {
			await this.backend.pullLatest();
			const nid = normalizeId(id);
			const { fm, body } = await this.readDoc(nid);
			fm.artifacts = fm.artifacts ?? [];
			fm.artifacts.push(artifact);
			await this.writeDoc(nid, fm, body);
			await this.reload();
			await this.rerender();
			await this.backend.commitAndPush(`Embed ${artifact.type} artifact in ${fm.title}`);
		});
	}

	async recordResult(id: string, result: Result): Promise<void> {
		await this.enqueue(async () => {
			await this.backend.pullLatest();
			const nid = normalizeId(id);
			if (!nid) {
				throw new Error(
					"The root is an overview and does not hold results. Record results on a sub-experiment; the root aggregates them automatically.",
				);
			}
			const { fm, body } = await this.readDoc(nid);
			fm.result = { ...result, at: result.at ?? nowIso() };
			await this.writeDoc(nid, fm, body);
			await this.reload();
			await this.rerender();
			await this.backend.commitAndPush(`Record result for ${fm.title}`);
		});
	}

	async attachTrace(id: string, ctx: ExtensionContext): Promise<string | null> {
		return this.enqueue(async () => {
			await this.backend.pullLatest();
			const nid = normalizeId(id);
			const { fm, body } = await this.readDoc(nid);
			const slug = nid ? nid.replace(/\//g, "-") : "root";
			const rel = await exportTrace(this.backend, ctx.sessionManager, slug);
			if (!rel) return null;
			fm.trace = rel;
			await this.writeDoc(nid, fm, body);
			await this.reload();
			await this.rerender();
			await this.backend.commitAndPush(`Attach trace to ${fm.title}`);
			return rel;
		});
	}

	async refreshStatus(): Promise<string> {
		return this.enqueue(async () => {
			await this.backend.pullLatest();
			this.jobStages = await pollJobStages(this.exec);
			await this.reload();
			await this.rerender();
			await this.backend.commitAndPush("Refresh experiment statuses");
			return this.treeText();
		});
	}

	async syncOnly(): Promise<void> {
		await this.enqueue(async () => {
			await this.backend.pullLatest();
			await this.reload();
			this.jobStages = await pollJobStages(this.exec);
			await this.rerender();
			await this.backend.commitAndPush("Sync experiment log");
		});
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("exp-local", {
		description: "Experiment log: use a local directory (path)",
		type: "string",
	});
	pi.registerFlag("exp-space", {
		description: "Experiment log: use a HuggingFace Space (org/name)",
		type: "string",
	});
	pi.registerFlag("exp-goal", {
		description: "Experiment log: high-level goal/title for the root page",
		type: "string",
	});

	const exec: Exec = (command, args, options) => pi.exec(command, args, options);
	let engine: Engine | null = null;

	const fmtVal = (v: number): string =>
		Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });

	/** Paint the footer status line + the above-editor panel (TUI only). */
	const paint = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || !engine) return;
		const s = engine.statusSummary();
		const th = ctx.ui.theme;

		// Footer: compact, next to cwd / model / thinking-level.
		const footer = [`🧪 ${s.goal}`];
		const segs: string[] = [];
		if (s.running) segs.push(`▶${s.running}`);
		if (s.done) segs.push(`✓${s.done}`);
		if (s.notStarted) segs.push(`·${s.notStarted}`);
		if (s.failed) segs.push(`✗${s.failed}`);
		if (segs.length) footer.push(segs.join(" "));
		if (s.best) footer.push(`★ ${fmtVal(s.best.value)}${s.best.units ? ` ${s.best.units}` : ""}`);
		ctx.ui.setStatus("experiment-log", footer.join("  ·  "));

		// Widget: a plan-mode-style panel of what's in progress.
		if (s.total === 0) {
			ctx.ui.setWidget("experiment-log", undefined);
			return;
		}
		const lines: string[] = [th.fg("accent", "EXPERIMENT LOG") + th.fg("dim", ` · ${s.goal}`)];
		if (s.runningList.length) {
			for (const r of s.runningList.slice(0, 6)) {
				lines.push(th.fg("accent", "▶ ") + th.fg("text", r.title));
			}
			if (s.runningList.length > 6) {
				lines.push(th.fg("dim", `  +${s.runningList.length - 6} more running`));
			}
		} else {
			lines.push(th.fg("dim", "no experiments in progress"));
		}
		if (s.best) {
			lines.push(
				th.fg("success", "★ best: ") +
					th.fg("muted", `${s.best.title} — ${fmtVal(s.best.value)}${s.best.units ? ` ${s.best.units}` : ""}`),
			);
		}
		ctx.ui.setWidget("experiment-log", lines, { placement: "aboveEditor" });
	};

	const initEngine = async (ctx: ExtensionContext): Promise<void> => {
		const spaceFlag = pi.getFlag("exp-space") as string | undefined;
		const localFlag = pi.getFlag("exp-local") as string | undefined;
		const goal = (pi.getFlag("exp-goal") as string | undefined) ?? "Experiment Log";

		let backend: Backend;
		if (spaceFlag) {
			const cacheDir = path.join(
				process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
				"exp-log-cache",
			);
			backend = new SpaceBackend(spaceFlag, cacheDir, exec);
		} else {
			const dir = localFlag
				? path.resolve(ctx.cwd, localFlag)
				: path.resolve(ctx.cwd, "experiment-log-data");
			backend = new LocalBackend(dir);
		}

		engine = new Engine(backend, exec, goal);
		try {
			await engine.init();
			if (ctx.hasUI) ctx.ui.notify(`Experiment log ready (${engine.describe()})`, "info");
		} catch (err) {
			engine = null;
			const msg = err instanceof Error ? err.message : String(err);
			if (ctx.hasUI) ctx.ui.notify(`Experiment log failed to start: ${msg}`, "error");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await initEngine(ctx);
		paint(ctx);
	});

	// Keep statuses live as jobs progress.
	pi.on("agent_end", async (_event, ctx) => {
		if (engine) await engine.refreshStatus().catch(() => {});
		paint(ctx);
	});

	// Repaint mid-turn after any experiment tool mutates state.
	pi.on("tool_execution_end", async (event, ctx) => {
		if (engine && event.toolName?.startsWith("experiment_")) paint(ctx);
	});

	// A short, always-on context block. The detail lives in skills that load on demand.
	pi.on("before_agent_start", async (event) => {
		if (!engine) return;
		const note = `\n\n# Experiment Log\nYou're collaborating in a shared experiment log. Overall goal: "${engine.goal()}".\nTrack your work with the experiment_* tools: experiment_tree to orient, experiment_get to read a relevant subtree, experiment_create for sub-experiments, experiment_link_job after launching an HF Job, experiment_record_result for headline metrics, experiment_embed_artifact for dashboards/datasets/plots.\nFavor incremental experimentation over one-shot attempts: if time and budget allow, first establish a baseline, then run small, cheap mini-experiments to probe promising directions, and aggregate their results before committing to a larger/longer run. Prefer several informative small jobs over one expensive guess.\nWhen running jobs or setting up monitoring, consult the \`hf-jobs\` and \`trackio-monitoring\` skills (read them when relevant).`;
		return { systemPrompt: event.systemPrompt + note };
	});

	// Advertise the workflow + HF expertise skills (progressive disclosure).
	pi.on("resources_discover", () => ({
		skillPaths: [
			path.join(baseDir, "..", "skill", "experiment-log", "SKILL.md"),
			path.join(baseDir, "..", "skill", "hf-jobs", "SKILL.md"),
			path.join(baseDir, "..", "skill", "trackio-monitoring", "SKILL.md"),
		],
	}));

	const requireEngine = (): Engine => {
		if (!engine) throw new Error("Experiment log is not initialized for this session.");
		return engine;
	};

	// ---- Tools ----------------------------------------------------------------

	pi.registerTool({
		name: "experiment_tree",
		label: "Experiment Tree",
		description:
			"Show the full experiment-log tree with each experiment's id, title, and aggregated status. Call this first to orient yourself before diving into a subtree.",
		promptSnippet: "experiment_tree: overview of the experiment log (ids + statuses)",
		parameters: Type.Object({}),
		async execute() {
			const text = requireEngine().treeText();
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "experiment_get",
		label: "Get Experiment",
		description:
			"Read one experiment's markdown plus a one-line summary of its sub-experiments. Use this to load only the subtree relevant to you instead of the whole log.",
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({ description: 'Experiment id (relative path). Empty or "root" for the root.' }),
			),
		}),
		async execute(_id, params) {
			const text = requireEngine().nodeView(normalizeId(params.id));
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "experiment_create",
		label: "Create Experiment",
		description:
			"Create a new experiment (or sub-experiment) with a title and a markdown body (goal/hypothesis/method). Returns its id.",
		promptSnippet: "experiment_create: add a (sub-)experiment to the log",
		parameters: Type.Object({
			title: Type.String({ description: "Short experiment title" }),
			parent_id: Type.Optional(
				Type.String({ description: 'Parent experiment id. Empty or "root" to add at the top level.' }),
			),
			body: Type.Optional(
				Type.String({ description: "Markdown body: goal, hypothesis, planned method." }),
			),
		}),
		async execute(_id, params) {
			const newId = await requireEngine().createExperiment(
				normalizeId(params.parent_id),
				params.title,
				params.body ?? "",
			);
			return {
				content: [{ type: "text", text: `Created experiment "${params.title}" with id: ${newId}` }],
				details: { id: newId },
			};
		},
	});

	pi.registerTool({
		name: "experiment_update",
		label: "Update Experiment",
		description:
			"Update an experiment's body (replace or append findings/notes) and/or set a manual status override (e.g. blocked, abandoned). Leave status empty to clear the override and return to job-derived status.",
		parameters: Type.Object({
			id: Type.String({ description: "Experiment id (relative path)." }),
			append: Type.Optional(Type.String({ description: "Markdown to append to the body." })),
			body: Type.Optional(Type.String({ description: "Replace the entire body with this markdown." })),
			status: Type.Optional(
				Type.String({ description: "Manual status override; empty string clears it." }),
			),
		}),
		async execute(_id, params) {
			await requireEngine().updateExperiment(normalizeId(params.id), {
				append: params.append,
				body: params.body,
				status: params.status,
			});
			return { content: [{ type: "text", text: `Updated experiment ${normalizeId(params.id) || "root"}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "experiment_link_job",
		label: "Link HF Job",
		description:
			"Record a HuggingFace Job id against an experiment. Status is then derived automatically by polling that job. Launch jobs yourself (e.g. via `hf jobs run`), then link the returned id here.",
		promptSnippet: "experiment_link_job: attach a HF Job id to an experiment for status tracking",
		parameters: Type.Object({
			id: Type.String({ description: "Experiment id (relative path)." }),
			job_id: Type.String({ description: "HuggingFace Job id." }),
		}),
		async execute(_id, params) {
			await requireEngine().linkJob(normalizeId(params.id), params.job_id.trim());
			return {
				content: [{ type: "text", text: `Linked job ${params.job_id} to ${normalizeId(params.id) || "root"}` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "experiment_embed_artifact",
		label: "Embed Artifact",
		description:
			"Attach an artifact to an experiment with access metadata so other agents can reach the underlying data. Types: trackio (space/project/query/url), dataset (repo/revision), image (path/data_path), link (href).",
		parameters: Type.Object({
			id: Type.String({ description: "Experiment id (relative path)." }),
			type: StringEnum(["trackio", "dataset", "image", "link"] as const),
			title: Type.Optional(Type.String({ description: "Artifact title." })),
			space: Type.Optional(Type.String({ description: "trackio: HF Space id (org/name)." })),
			project: Type.Optional(Type.String({ description: "trackio: project name." })),
			query: Type.Optional(
				Type.String({ description: "trackio: a `trackio query ...` command to pull the raw data." }),
			),
			url: Type.Optional(Type.String({ description: "trackio/link: dashboard or resource URL." })),
			repo: Type.Optional(Type.String({ description: "dataset: HF dataset repo id." })),
			revision: Type.Optional(Type.String({ description: "dataset: revision/branch." })),
			path: Type.Optional(Type.String({ description: "image: path to the image, relative to the experiment." })),
			data_path: Type.Optional(
				Type.String({ description: "image: path to the raw data behind the plot." }),
			),
			href: Type.Optional(Type.String({ description: "link: target URL." })),
			note: Type.Optional(Type.String({ description: "Optional note." })),
		}),
		async execute(_id, params) {
			const { id, ...rest } = params;
			await requireEngine().embedArtifact(normalizeId(id), rest as Artifact);
			return {
				content: [{ type: "text", text: `Embedded ${params.type} artifact in ${normalizeId(id) || "root"}` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "experiment_record_result",
		label: "Record Result",
		description:
			"Record a sub-experiment's primary numeric result (the metric being optimized). Results feed the root overview: a leaderboard and a score-evolution chart. Cannot be set on the root.",
		promptSnippet: "experiment_record_result: record a sub-experiment's headline metric value",
		parameters: Type.Object({
			id: Type.String({ description: "Experiment id (relative path). Not the root." }),
			metric: Type.String({ description: "Metric name, e.g. 'tokens/sec' or 'accuracy'." }),
			value: Type.Number({ description: "Numeric value of the metric." }),
			higher_is_better: Type.Optional(
				Type.Boolean({ description: "Whether higher is better (default true)." }),
			),
			units: Type.Optional(Type.String({ description: "Optional units, e.g. 'tok/s'." })),
		}),
		async execute(_id, params) {
			await requireEngine().recordResult(normalizeId(params.id), {
				metric: params.metric,
				value: params.value,
				higher_is_better: params.higher_is_better,
				units: params.units,
			});
			return {
				content: [
					{
						type: "text",
						text: `Recorded ${params.metric}=${params.value}${params.units ? " " + params.units : ""} for ${normalizeId(params.id)}`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "experiment_refresh_status",
		label: "Refresh Status",
		description: "Re-poll HuggingFace Jobs and recompute every experiment's status. Returns the updated tree.",
		parameters: Type.Object({}),
		async execute() {
			const text = await requireEngine().refreshStatus();
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "experiment_attach_trace",
		label: "Attach Trace",
		description:
			"Export the current session's full agent trace to JSONL and link it from an experiment page, so others can inspect how the work was done.",
		parameters: Type.Object({
			id: Type.String({ description: "Experiment id (relative path)." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const rel = await requireEngine().attachTrace(normalizeId(params.id), ctx);
			return {
				content: [
					{ type: "text", text: rel ? `Trace attached: ${rel}` : "No trace to export (empty session)." },
				],
				details: { trace: rel },
			};
		},
	});

	// ---- Commands -------------------------------------------------------------

	pi.registerCommand("exp", {
		description: "Experiment log: open (default), tree, sync. Usage: /exp [tree|sync|open <id>]",
		handler: async (args, ctx) => {
			if (!engine) {
				ctx.ui.notify("Experiment log is not initialized.", "error");
				return;
			}
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "tree") {
				ctx.ui.notify(engine.treeText(), "info");
				return;
			}
			if (sub === "sync") {
				await engine.syncOnly();
				ctx.ui.notify("Experiment log synced.", "info");
				return;
			}
			// default / open: open the (root or given) experiment HTML in a browser
			const id = sub === "open" ? normalizeId(rest[0]) : "";
			const htmlAbs = engine.localPathFor(id ? `${id}/index.html` : "index.html");
			await pi.exec("open", [htmlAbs]).catch(() => {});
			ctx.ui.notify(`Opening ${htmlAbs}`, "info");
		},
	});
}
