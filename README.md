# pi-experiment-log

A [pi](https://github.com/earendil-works/pi) extension that turns a directory — or a shared
HuggingFace Space — into a **nested, agent-collaborative experiment log** backed by HuggingFace
Jobs. It's a collaboration substrate for ML research efforts (e.g. the
[Fast Gemma Challenge](https://huggingface.co/gemma-challenge)): a researcher's agent can land,
read the tree cheaply, see what's running right now, and contribute.

## Install

Requires [pi](https://github.com/earendil-works/pi), the `hf` CLI, and Node. Clone the repo and
install dependencies:

```bash
git clone https://github.com/abidlabs/pi-experiment-log-extension
cd pi-experiment-log-extension
npm install
```

Then either run it ad-hoc with the `-e` flag, or install it into pi:

```bash
# Ad-hoc (always picks up local edits) — run from anywhere with an absolute path
pi -e ./src/index.ts --exp-local ./my-log --exp-goal "Optimize tok/s of Gemma on a10g-small"

# Install project-locally (auto-loads when you run pi in that project)
pi install /path/to/pi-experiment-log-extension -l

# Or install globally (loads in every pi session)
pi install /path/to/pi-experiment-log-extension
```

To uninstall: `pi remove /path/to/pi-experiment-log-extension` (add `-l` for the project-local one).

## What it does

- **Nested experiments.** A root page states the high-level goal; sub-experiments (and
  sub-sub-experiments) nest underneath, each its own page.
- **Markdown is canonical, HTML is generated.** Agents read/write the `.md`; humans open a
  styled `.html` (editorial design, score-evolution chart on the root).
- **HF Job status, derived.** Each experiment tracks 0..N HuggingFace Jobs; status
  (`not started` / `in progress` / `complete` / `failed`) is polled from `hf jobs` and aggregated
  up the tree. The root is an overview only — no job, no status.
- **Embeddable artifacts with access metadata.** Trackio dashboards, datasets, images, and links
  — each stored with the metadata an agent needs to reach the underlying data (e.g. the
  `trackio query` command behind a chart).
- **Context-efficient.** `experiment_tree` orients an agent for almost no tokens; `experiment_get`
  loads only the relevant subtree.
- **In-terminal presence.** A footer line shows the goal + live counts next to cwd/model, and a
  plan-mode-style panel lists in-progress experiments.
- **On-demand expertise.** Ships `hf-jobs` and `trackio-monitoring` skills (progressive
  disclosure — only loaded when relevant) plus a short system-prompt nudge toward incremental
  experimentation (baseline → small probes → aggregate, instead of one-shotting).
- **Local or Space backend, chosen at startup.** In Space mode, each change is `git pull
  --rebase` → commit → push, so multiple people/agents collaborate on one log.

## Usage

### Choose a backend at startup

```bash
pi -e ./src/index.ts --exp-local ./my-log         # a local directory
pi -e ./src/index.ts --exp-space your-org/my-log   # a HuggingFace Space (git pull/push per change)
```

Optional `--exp-goal "<text>"` seeds the root page's high-level goal on first run.

### Tools the agent can call

| Tool | Purpose |
|------|---------|
| `experiment_tree` | Compact overview of the whole tree (ids + statuses). |
| `experiment_get` | Read one experiment's markdown + its children's summaries. |
| `experiment_create` | Create a (sub-)experiment with a title and goal/hypothesis body. |
| `experiment_link_job` | Record an HF Job id on an experiment (status is then polled automatically). |
| `experiment_record_result` | Record a headline metric value (feeds the root's score-evolution chart). |
| `experiment_embed_artifact` | Attach a trackio dashboard / dataset / image / link with access metadata. |
| `experiment_update` | Edit the body or set a manual status override. |
| `experiment_attach_trace` | Export the current session trace to JSONL and link it from the page. |
| `experiment_refresh_status` | Re-poll HF Jobs and recompute statuses. |

### Commands

```
/exp            open the root overview in your browser
/exp open <id>  open a specific experiment
/exp tree       print the tree
/exp sync       pull + push (Space backend)
```

## On-disk layout

```
<log-root>/
  index.md            # root: the high-level goal (canonical; agents read this)
  index.html          # generated overview (humans): score-evolution chart
  assets/style.css
  <slug>/             # an experiment
    index.md          # frontmatter: status override, jobs[], artifacts[], result
    index.html
    <subslug>/        # a sub-experiment (recursion = nesting)
  traces/<slug>.jsonl # exported agent traces
```

## Development

```bash
npm install
node --experimental-strip-types test/smoke.ts   # deterministic core-logic test
```

Source layout: `src/backend.ts` (local + Space backends), `src/experiment.ts` (frontmatter +
tree), `src/status.ts` (HF-job polling + aggregation), `src/render.ts` (markdown → HTML),
`src/trace.ts` (trace export), `src/index.ts` (tools, commands, terminal UI, prompt/skills wiring).

## Acknowledgements

The `hf-jobs` and `trackio-monitoring` skills distill operational guidance from
[huggingface/ml-intern](https://github.com/huggingface/ml-intern)'s system prompt, retargeted to
the `hf jobs` CLI.
