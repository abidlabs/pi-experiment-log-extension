/**
 * Deterministic smoke test of the core substrate (no pi, no LLM).
 * Run: node --experimental-strip-types test/smoke.ts
 */
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalBackend } from "../src/backend.ts";
import {
	type Artifact,
	type Frontmatter,
	findNode,
	loadTree,
	mdPath,
	parseDoc,
	serializeDoc,
	slugify,
} from "../src/experiment.ts";
import { renderAll } from "../src/render.ts";
import { aggregate, mapStage } from "../src/status.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "explog-"));
const backend = new LocalBackend(tmp);

function nowIso() {
	return new Date().toISOString();
}

// --- frontmatter round-trip ---
const rt = parseDoc(serializeDoc({ title: "X", jobs: [{ id: "j1" }] }, "# body\n\nhi"));
assert.equal(rt.fm.title, "X");
assert.equal(rt.fm.jobs?.[0].id, "j1");
assert.ok(rt.body.includes("hi"));
console.log("✓ frontmatter round-trip");

// --- stage mapping ---
assert.equal(mapStage("COMPLETED"), "done");
assert.equal(mapStage("RUNNING"), "running");
assert.equal(mapStage("ERROR"), "failed");
console.log("✓ stage mapping");

// --- build a small tree on disk ---
await backend.writeFile(
	mdPath(""),
	serializeDoc({ title: "Optimize Gemma tok/s", created: nowIso() }, "# Goal\n\nMake it fast."),
);
const children = ["INT8 quant", "FP8 quant", "Flash attention"];
for (const title of children) {
	await backend.writeFile(
		mdPath(slugify(title)),
		serializeDoc({ title, created: nowIso() }, `# ${title}\n\nHypothesis.`),
	);
}

// link a completed job to one, leave others without jobs
const int8 = parseDoc((await backend.readFile(mdPath("int8-quant")))!);
int8.fm.jobs = [{ id: "job-done" }];
const art: Artifact = {
	type: "trackio",
	title: "tok/s",
	space: "me/gemma-trackio",
	project: "gemma",
	query: "trackio query --project gemma 'SELECT * FROM metrics'",
	url: "https://me-gemma-trackio.hf.space",
};
int8.fm.artifacts = [art];
await backend.writeFile(mdPath("int8-quant"), serializeDoc(int8.fm, int8.body));

const tree = await loadTree(backend);
assert.ok(tree, "tree built");
assert.equal(tree!.children.length, 3, "three children");
assert.equal(tree!.fm.title, "Optimize Gemma tok/s");

// stub job stages: job-done completed
const jobStages = new Map<string, string>([["job-done", "COMPLETED"]]);

const int8Node = findNode(tree!, "int8-quant")!;
assert.equal(aggregate(int8Node, jobStages), "done", "int8 done");
const fp8Node = findNode(tree!, "fp8-quant")!;
assert.equal(aggregate(fp8Node, jobStages), "not-started", "fp8 not started");
// root: mix of done + not-started => running (in progress)
assert.equal(aggregate(tree!, jobStages), "running", "root in progress");
console.log("✓ status aggregation (done / not-started / mixed=running)");

// --- render html ---
await renderAll(backend, tree!, jobStages);
for (const p of ["index.html", "int8-quant/index.html", "assets/style.css"]) {
	assert.ok(await backend.exists(p), `${p} exists`);
}
const int8Html = (await backend.readFile("int8-quant/index.html"))!;
assert.ok(int8Html.includes("tok/s"), "artifact title in html");
assert.ok(int8Html.includes("me-gemma-trackio.hf.space"), "trackio iframe url in html");
assert.ok(int8Html.includes("trackio query"), "trackio query metadata in html");
assert.ok(int8Html.includes("status-done"), "done badge in html");
const rootHtml = (await backend.readFile("index.html"))!;
assert.ok(rootHtml.includes("Flash attention"), "nav lists children");
// Root is an overview: no status badge in its header.
assert.ok(!/exp-header[\s\S]*?badge/.test(rootHtml), "root header has no status badge");
console.log("✓ html rendering (artifacts, badges, nav)");

// --- results + root overview ---
const recordResult = async (id: string, value: number) => {
	const d = parseDoc((await backend.readFile(mdPath(id)))!);
	d.fm.result = { metric: "tokens/sec", value, higher_is_better: true, units: "tok/s", at: nowIso() };
	await backend.writeFile(mdPath(id), serializeDoc(d.fm, d.body));
};
await recordResult("int8-quant", 412);
await recordResult("fp8-quant", 388);
const tree2 = (await loadTree(backend))!;
await renderAll(backend, tree2, jobStages);
const rootHtml2 = (await backend.readFile("index.html"))!;
assert.ok(rootHtml2.includes("Score Evolution"), "chart section present");
assert.ok(rootHtml2.includes("chart.js"), "chart.js loaded");
assert.ok(rootHtml2.includes("tokens/sec"), "metric shown");
assert.ok(!rootHtml2.includes("Leaderboard"), "leaderboard removed from root");
assert.ok(rootHtml2.includes('"y":412'), "result value in chart data");
// child pages still carry status; root still does not
const int8Html2 = (await backend.readFile("int8-quant/index.html"))!;
assert.ok(int8Html2.includes("status-done"), "child keeps status badge");
console.log("✓ root overview (chart only, no leaderboard, root has no status)");

console.log(`\nAll smoke checks passed. Output at: ${tmp}`);
console.log(`Open: ${path.join(tmp, "index.html")}`);
