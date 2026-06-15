/**
 * HTML rendering. Markdown is canonical; we generate one index.html per
 * experiment for human consumption: nav sidebar (whole tree + statuses),
 * breadcrumb, status badge, rendered body, and embedded artifacts.
 *
 * Agents read the .md directly; humans open the .html.
 */

import { marked } from "marked";
import type { Backend } from "./backend.ts";
import {
	ancestorsOf,
	type Artifact,
	depthOf,
	type ExperimentNode,
	findNode,
	flatten,
	htmlPath,
	type Result,
} from "./experiment.ts";
import { aggregate, mapStage, type Status, STATUS_LABELS } from "./status.ts";

marked.setOptions({ gfm: true, breaks: false });

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Relative href from a node at `fromId` to the root-relative path `target`. */
function rel(fromId: string, target: string): string {
	const prefix = "../".repeat(depthOf(fromId));
	return prefix + target;
}

function statusBadge(status: Status): string {
	const label = STATUS_LABELS[status] ?? status;
	return `<span class="badge status-${esc(status)}">${esc(label)}</span>`;
}

function renderArtifact(art: Artifact): string {
	const title = esc(art.title ?? art.type);
	switch (art.type) {
		case "trackio": {
			const meta: string[] = [];
			if (art.space) meta.push(`<dt>space</dt><dd><code>${esc(art.space)}</code></dd>`);
			if (art.project) meta.push(`<dt>project</dt><dd><code>${esc(art.project)}</code></dd>`);
			if (art.query) meta.push(`<dt>query</dt><dd><code>${esc(art.query)}</code></dd>`);
			const iframe = art.url
				? `<iframe class="trackio" src="${esc(art.url)}" loading="lazy"></iframe>`
				: "";
			return `<section class="artifact trackio">
  <h3>📊 ${title}</h3>
  ${iframe}
  <dl class="meta">${meta.join("\n  ")}</dl>
</section>`;
		}
		case "image": {
			const img = art.path ? `<img src="${esc(art.path)}" alt="${title}" />` : "";
			const data = art.data_path
				? `<p class="meta">raw data: <a href="${esc(art.data_path)}"><code>${esc(art.data_path)}</code></a></p>`
				: "";
			return `<section class="artifact image">
  <h3>🖼️ ${title}</h3>
  ${img}
  ${data}
</section>`;
		}
		case "dataset": {
			const rev = art.revision ? `, revision="${esc(art.revision)}"` : "";
			const snippet = art.repo
				? `<pre><code>load_dataset("${esc(art.repo)}"${rev})</code></pre>`
				: "";
			const link = art.repo
				? `<p class="meta"><a href="https://huggingface.co/datasets/${esc(art.repo)}">huggingface.co/datasets/${esc(art.repo)}</a></p>`
				: "";
			return `<section class="artifact dataset">
  <h3>🗃️ ${title}</h3>
  ${link}
  ${snippet}
</section>`;
		}
		default: {
			const href = art.href ?? art.url ?? "#";
			const note = art.note ? ` — ${esc(art.note)}` : "";
			return `<section class="artifact link">
  <h3>🔗 <a href="${esc(href)}">${title}</a></h3>
  <p class="meta">${esc(href)}${note}</p>
</section>`;
		}
	}
}

function renderNav(root: ExperimentNode, currentId: string, jobStages: Map<string, string>): string {
	const renderItem = (node: ExperimentNode): string => {
		const href = rel(currentId, htmlPath(node.id));
		const isCurrent = node.id === currentId;
		const cls = `nav-item${isCurrent ? " current" : ""}`;
		const label = esc(node.fm.title) || "(root)";
		// The root is an overview and shows no status dot.
		const dot = node.id ? `<span class="dot status-${esc(aggregate(node, jobStages))}"></span>` : "";
		const children = node.children.length
			? `<ul>${node.children.map(renderItem).join("")}</ul>`
			: "";
		return `<li><a class="${cls}" href="${esc(href)}">${dot}${label}</a>${children}</li>`;
	};
	return `<nav class="tree"><ul>${renderItem(root)}</ul></nav>`;
}

function renderBreadcrumb(root: ExperimentNode, currentId: string): string {
	const ids = [...ancestorsOf(currentId), currentId];
	const parts = ids.map((id) => {
		const node = findNode(root, id);
		const title = node ? esc(node.fm.title) : esc(id);
		if (id === currentId) return `<span>${title}</span>`;
		return `<a href="${esc(rel(currentId, htmlPath(id)))}">${title}</a>`;
	});
	return `<div class="breadcrumb">${parts.join(' <span class="sep">/</span> ')}</div>`;
}

interface OverviewEntry {
	id: string;
	title: string;
	result: Result;
}

/**
 * Root-only overview: a score-evolution chart built from every descendant that
 * has recorded a numeric result. Returns empty when there is no result data
 * yet, so the root stays clean until experiments report.
 */
function renderOverview(
	root: ExperimentNode,
	_jobStages: Map<string, string>,
): { html: string; needsChart: boolean } {
	const entries: OverviewEntry[] = flatten(root)
		.filter((n) => n.id && n.fm.result && typeof n.fm.result.value === "number")
		.map((n) => ({ id: n.id, title: n.fm.title, result: n.fm.result as Result }));

	if (entries.length === 0) return { html: "", needsChart: false };

	const metric = entries[0].result.metric;
	const higherIsBetter =
		entries.filter((e) => e.result.higher_is_better === false).length <=
		entries.filter((e) => e.result.higher_is_better !== false).length;

	// Chart: scatter of all results over time + best-so-far step line.
	const byTime = [...entries]
		.map((e) => ({ x: Date.parse(e.result.at ?? "") || 0, y: e.result.value, label: e.title }))
		.sort((a, b) => a.x - b.x);
	const bestLine: Array<{ x: number; y: number }> = [];
	let best = higherIsBetter ? -Infinity : Infinity;
	for (const p of byTime) {
		best = higherIsBetter ? Math.max(best, p.y) : Math.min(best, p.y);
		bestLine.push({ x: p.x, y: best });
	}

	const chart = `<section class="overview-chart">
  <h2>Score Evolution <span class="section-hint">${esc(metric)} over time</span></h2>
  <div class="chart-wrap"><canvas id="score-chart"></canvas></div>
  <script>
  (function(){
    var pts = ${JSON.stringify(byTime)};
    var best = ${JSON.stringify(bestLine)};
    var el = document.getElementById('score-chart');
    if (!el || !window.Chart) return;
    new Chart(el, {
      data: { datasets: [
        { type:'line', label:'best', data: best, stepped:true, borderColor:'#0f3787',
          backgroundColor:'rgba(15,55,135,0.07)', fill:true, pointRadius:0, borderWidth:1.5, order:1 },
        { type:'scatter', label:'results', data: pts, backgroundColor:'rgba(15,55,135,0.55)',
          borderColor:'#0f3787', pointRadius:4, pointHoverRadius:6, order:2 }
      ] },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false},
          tooltip:{ callbacks:{ label:function(c){ return c.raw.label ? c.raw.label+': '+c.raw.y : String(c.raw.y); } } } },
        scales:{
          x:{ type:'linear', grid:{color:'#eee'},
            ticks:{ color:'#888', font:{family:'JetBrains Mono', size:10},
              callback:function(v){ return new Date(v).toLocaleDateString(undefined,{month:'short',day:'numeric'}); } } },
          y:{ grid:{color:'#eee'}, ticks:{ color:'#888', font:{family:'JetBrains Mono', size:10} } }
        }
      }
    });
  })();
  </script>
</section>`;

	return { html: chart, needsChart: true };
}

function page(opts: {
	root: ExperimentNode;
	node: ExperimentNode;
	jobStages: Map<string, string>;
}): string {
	const { root, node, jobStages } = opts;
	const isRoot = !node.id;
	const cssHref = rel(node.id, "assets/style.css");
	const bodyHtml = marked.parse(node.body || "_No description yet._") as string;

	// Root is an overview only: no status badge, no jobs.
	const headerBadge = isRoot ? "" : statusBadge(aggregate(node, jobStages));

	// Auto leaderboard + score-evolution chart on the root, when data exists.
	const overview = isRoot ? renderOverview(root, jobStages) : { html: "", needsChart: false };

	const jobs = isRoot ? [] : (node.fm.jobs ?? []);
	const jobsHtml = jobs.length
		? `<section class="jobs"><h2>Jobs</h2><ul>${jobs
				.map((j) => {
					const known = jobStages.has(j.id);
					const badge = statusBadge(known ? mapStage(jobStages.get(j.id)) : "running");
					return `<li><code>${esc(j.id)}</code> ${badge} <a href="https://huggingface.co/jobs/${esc(j.id)}">view</a></li>`;
				})
				.join("")}</ul></section>`
		: "";

	const arts = node.fm.artifacts ?? [];
	const artsHtml = arts.length
		? `<section class="artifacts"><h2>Artifacts</h2>${arts.map(renderArtifact).join("\n")}</section>`
		: "";

	const traceHtml = node.fm.trace
		? `<section class="trace"><h2>Agent trace</h2><p><a href="${esc(rel(node.id, node.fm.trace))}">${esc(node.fm.trace)}</a></p></section>`
		: "";

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(node.fm.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="${esc(cssHref)}" />
${overview.needsChart ? '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>' : ""}
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-title">Experiment Log</div>
    ${renderNav(root, node.id, jobStages)}
  </aside>
  <main class="content">
    ${renderBreadcrumb(root, node.id)}
    <header class="exp-header">
      <h1>${esc(node.fm.title)}</h1>
      ${headerBadge}
    </header>
    <article class="body">${bodyHtml}</article>
    ${overview.html}
    ${jobsHtml}
    ${artsHtml}
    ${traceHtml}
  </main>
</div>
</body>
</html>`;
}

const STYLE = `*{margin:0;padding:0;box-sizing:border-box}
:root{
 --bg:#fafafa;--bg-soft:#f4f4f4;--bg-card:#fff;
 --border:#ddd;--border-soft:#eee;
 --ink:#1a1a1a;--ink-2:#2a2a2a;--ink-3:#444;
 --muted:#555;--muted-2:#777;--muted-3:#888;--muted-4:#999;
 --accent:#0f3787;--accent-deep:#0a275f;--accent-soft:#dde6f5;
}
body{font-family:"Inter","Helvetica Neue",sans-serif;font-size:13px;font-weight:300;line-height:1.6;color:var(--ink);background:var(--bg)}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-deep)}
.layout{display:flex;min-height:100vh;align-items:stretch}
.sidebar{width:300px;flex:0 0 300px;background:var(--bg-card);border-right:1px solid var(--border);padding:24px 20px;position:sticky;top:0;height:100vh;overflow:auto}
.sidebar-title{font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:500;letter-spacing:2px;text-transform:uppercase;color:var(--ink-3);margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.tree ul{list-style:none;padding-left:14px}
.tree>ul{padding-left:0}
.tree li{margin:1px 0}
.nav-item{display:flex;align-items:center;gap:9px;padding:5px 8px;border-radius:3px;color:var(--ink-2);font-size:12.5px;font-weight:400;line-height:1.35}
.nav-item:hover{background:var(--bg-soft);color:var(--ink)}
.nav-item.current{background:var(--accent-soft);color:var(--accent-deep);font-weight:500}
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 8px;background:#c9c9c9}
.content{flex:1;max-width:900px;padding:32px 44px 72px}
.breadcrumb{font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:var(--muted-3);margin-bottom:16px}
.breadcrumb a{color:var(--muted-2)}
.breadcrumb a:hover{color:var(--accent)}
.breadcrumb .sep{margin:0 7px;color:var(--muted-4)}
.exp-header{display:flex;align-items:center;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:16px}
.exp-header h1{font-family:"JetBrains Mono",monospace;font-size:25px;font-weight:500;letter-spacing:.2px;line-height:1.2;color:var(--ink)}
.badge{font-family:"JetBrains Mono",monospace;font-size:10px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;padding:3px 9px;border-radius:3px;border:1px solid transparent;white-space:nowrap}
.status-not-started{background:var(--bg-soft);color:var(--muted-2);border-color:#e2e2e2}
.dot.status-not-started{background:#c9c9c9}
.status-running{background:#fbf3df;color:#8a6d1f;border-color:#ecdca8}
.dot.status-running{background:#c69026}
.status-done{background:var(--accent);color:#fff;border-color:var(--accent)}
.dot.status-done{background:var(--accent)}
.status-failed{background:#fbe9e7;color:#b3261e;border-color:#f3c9c2}
.dot.status-failed{background:#b3261e}
.status-cancelled{background:var(--bg-soft);color:var(--muted-4);border-color:#e6e6e6}
.dot.status-cancelled{background:#bbb}
.body{margin-top:22px;font-size:14px;color:var(--ink-2);line-height:1.7}
.body h1,.body h2,.body h3{font-family:"JetBrains Mono",monospace;font-weight:500;letter-spacing:.2px;color:var(--ink);margin:1.5em 0 .5em;line-height:1.3}
.body h1{font-size:19px}
.body h2{font-size:16px}
.body h3{font-size:14px}
.body p{margin:.7em 0}
.body ul,.body ol{margin:.6em 0;padding-left:1.4em}
.body a{border-bottom:1px solid var(--accent);padding-bottom:1px}
.body code{font-family:"JetBrains Mono",monospace;background:var(--bg-soft);border:1px solid var(--border-soft);padding:1px 5px;border-radius:3px;font-size:.85em}
.body pre{background:var(--bg-soft);border:1px solid var(--border);padding:14px 16px;border-radius:3px;overflow:auto;margin:1em 0}
.body pre code{background:none;border:none;padding:0;font-size:12px;color:var(--ink-2)}
.body blockquote{border-left:3px solid var(--border);padding-left:14px;color:var(--muted);margin:1em 0}
section{margin-top:30px}
section>h2{display:flex;align-items:center;gap:12px;font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:400;text-transform:uppercase;letter-spacing:2px;color:var(--ink-3);border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:14px}
.section-hint{margin-left:auto;color:var(--muted-3);font-size:10px;font-weight:300;letter-spacing:.5px;text-transform:none}
.chart-wrap{position:relative;height:340px;border:1px solid var(--border);background:#fff;padding:12px}
.lb-scroll{overflow-x:auto}
.lb-table{font-family:"JetBrains Mono",monospace;width:100%;border-collapse:collapse;font-size:11px;font-weight:300;background:#fff;border:1px solid var(--border)}
.lb-table th,.lb-table td{text-align:left;padding:8px 12px;vertical-align:middle;font-variant-numeric:tabular-nums}
.lb-table th{font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:1px;color:var(--muted-2);border-bottom:1px solid var(--border);background:var(--bg-soft)}
.lb-table th.num,.lb-table td.num{text-align:right}
.lb-table tr{border-bottom:1px solid var(--border-soft)}
.lb-table tbody tr:last-child{border-bottom:none}
.lb-table tbody tr:hover td{background:#fafafa}
.lb-table tr.best td{background:var(--accent-soft)}
.lb-table tr.best:hover td{background:#c8d6ee}
.lb-table .rank{color:var(--muted-3)}
.lb-table .name a{color:var(--ink);font-weight:500;border-bottom:none}
.lb-table .name a:hover{color:var(--accent)}
.lb-table tr.best .val{color:var(--accent);font-weight:600}
.artifact{border:1px solid var(--border);background:var(--bg-card);padding:16px;margin-bottom:14px}
.artifact h3{font-family:"JetBrains Mono",monospace;font-size:13px;font-weight:500;margin-bottom:10px;color:var(--ink)}
.artifact .trackio{width:100%;height:440px;border:1px solid var(--border);background:#fff}
.artifact img{max-width:100%;border:1px solid var(--border)}
.artifact .meta{font-size:12px;color:var(--muted-2);margin-top:8px}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:5px 14px;font-family:"JetBrains Mono",monospace;font-size:11px;margin-top:10px}
dl.meta dt{color:var(--muted-3);text-transform:uppercase;letter-spacing:.5px;font-size:10px}
dl.meta dd{margin:0;color:var(--ink-2);word-break:break-word}
.jobs ul{list-style:none}
.jobs li{font-family:"JetBrains Mono",monospace;font-size:12px;margin:7px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.trace p{font-family:"JetBrains Mono",monospace;font-size:12px}
@media(max-width:820px){.layout{flex-direction:column}.sidebar{width:auto;flex:none;height:auto;position:static;border-right:none;border-bottom:1px solid var(--border)}.content{padding:24px 18px 56px}}
`;

/**
 * Regenerate every node's HTML page and the shared stylesheet.
 * Cheap for the small trees we expect; keeps all pages consistent.
 */
export async function renderAll(
	backend: Backend,
	root: ExperimentNode,
	jobStages: Map<string, string>,
): Promise<void> {
	await backend.writeFile("assets/style.css", STYLE);
	for (const node of flatten(root)) {
		await backend.writeFile(htmlPath(node.id), page({ root, node, jobStages }));
	}
}
