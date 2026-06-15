---
name: trackio-monitoring
description: How to monitor HF training runs with Trackio — emit alerts at decision points, read them back between runs to drive the next config, and embed the dashboard in the experiment log. Use when setting up or analyzing training metrics.
---

# Monitoring training with Trackio

Trackio is natively integrated with Transformers `Trainer` and all TRL trainers (the built-in
`TrackioCallback` handles init/log/finish).

## Enable it

In `TrainingArguments` / `SFTConfig` / `DPOConfig` / `GRPOConfig`:
```python
report_to="trackio"
run_name="sft_qwen3-4b_lr2e-5_bs128"        # descriptive
project="<descriptive-project>"              # groups related runs for comparison
trackio_space_id="<user>/<8-char-id>"        # creates a public dashboard Space
```
`project` and `trackio_space_id` can also come from `TRACKIO_PROJECT` / `TRACKIO_SPACE_ID`.

## Alerts are how iterations decide what to change

Call `trackio.alert(title, text, level)` at every decision point. Always include numeric values
and an actionable suggestion in `text` (e.g. `"loss=12.4 at step 200 — lr likely too high, try x0.1"`)
so a later run can parse and act on it.

- `ERROR` — stop and change approach (divergence, NaN, OOM)
- `WARN`  — tweak hyperparameters (overfitting, KL spike, reward collapse, slow convergence)
- `INFO`  — milestones (target reached, checkpoint saved, training complete)

Add alerts via a `TrainerCallback` in `callbacks=[...]`: check training metrics in `on_log`
(loss/reward/kl) and eval metrics in `on_evaluate`. Keep each condition simple — one metric, one
threshold — so it's easy to adjust between runs.

## Read alerts back, then drive the next config

Don't parse thousands of metric points — read the alerts (always `--json`):
```
trackio get alerts --project <p> --run <r> --json
trackio get alerts --project <p> --since <iso8601> --json   # incremental polling
trackio get run    --project <p> --run <r> --json
trackio list runs  --project <p> --json
```
Python: `api = trackio.Api(); api.alerts(p, run=r, since=ts); api.runs(p)`.

Map alerts → next config: diverged → `lr x0.1`; overfitting → `weight_decay x10` or less capacity;
early stopping → `lr x0.5`; high accuracy → refine around current config. Only mutate the keys the
alerts justify.

## Record it in the experiment log

Once a run has a dashboard, attach it: call `experiment_embed_artifact` with `type: trackio`,
the dashboard `url`, the `space`/`project`, and a `query` (a `trackio query`/`trackio get … --json`
command) so other agents can pull the raw numbers. When you have a headline metric, call
`experiment_record_result` so it feeds the root's score-evolution chart.
