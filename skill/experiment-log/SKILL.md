---
name: experiment-log
description: How to read and contribute to the shared nested experiment log (backed by HuggingFace Jobs). Use whenever you are doing ML experiments tracked in this log.
---

# Experiment Log

This workspace has a **nested experiment log**: a tree of experiments working toward a
high-level goal. Each experiment is a markdown page; sub-experiments nest underneath it.
Each can track 0..N HuggingFace Jobs, and its status (`not started` / `in progress` /
`complete` / `failed`) is derived automatically from those jobs.

Markdown is canonical — you read and write it through the tools below. Humans read a
generated HTML version. The log may be local or backed by a shared HuggingFace Space, so
**other people and agents are contributing in parallel**.

## Workflow when you arrive

1. **Orient cheaply.** Call `experiment_tree` to see the whole tree with ids and statuses.
   Don't read everything — the tree is the index.
2. **Read only what's relevant.** Call `experiment_get` with an experiment id to read that
   page plus a one-line summary of its children. Drill into the subtree you'll work on.
3. **Pick how to contribute:**
   - Run an experiment that is **not started**: launch the HF Job yourself
     (e.g. `hf jobs run ...` or `hf jobs uv ...`), then call `experiment_link_job` with the
     returned job id. Status updates automatically as the job runs.
   - Add a **new idea**: call `experiment_create` at the root or under a relevant parent
     with a title and a body stating the goal/hypothesis/method.
   - Record **findings** on an existing experiment: `experiment_update` (append results,
     or set a manual status like `blocked`/`abandoned` that a job can't express).
4. **Attach evidence.** Use `experiment_embed_artifact` to link a trackio dashboard
   (include the `query` so others can pull the raw data), a dataset (`repo`), an image
   (`path` + `data_path`), or a link.
5. **Preserve provenance.** `experiment_attach_trace` exports this session's full trace and
   links it from the experiment page so others can see how the result was produced.

## Notes

- Experiment ids are relative paths, e.g. `quantize/int8`. Empty / `root` means the root.
- `experiment_refresh_status` re-polls jobs and recomputes statuses; it also runs
  automatically at the end of each turn.
- Keep experiment bodies concise and structured (Goal / Hypothesis / Method / Findings) so
  the next agent can absorb a subtree without reading the whole history.
