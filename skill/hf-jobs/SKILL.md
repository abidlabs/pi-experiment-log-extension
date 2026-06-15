---
name: hf-jobs
description: How to run HuggingFace Jobs correctly from the CLI for ML training/eval — avoiding the common failures (lost models, killed jobs, batch wipeouts). Use whenever launching, sizing, or debugging an HF Job for an experiment.
---

# Running HuggingFace Jobs

HF Jobs run training/eval in a **fresh, ephemeral cloud environment**. The mistakes below are
the ones that waste the most time and money — avoid them by default.

## Non-negotiable rules

- **Storage is ephemeral.** The job filesystem is deleted when the job ends. In training config
  set `push_to_hub=True` and `hub_model_id="<user>/<name>"`, or the trained model is lost forever.
- **Set a real timeout.** The default (~30m) silently kills training. Use ≥ 2h for any training
  run; size it to the model + hardware. A killed job loses all progress.
- **Submit ONE job first.** For any batch/ablation/sweep: launch a single job, confirm from its
  logs that it actually starts training, *then* submit the rest. Otherwise one bug fails all of them.
- **No local paths in the job script.** `/Users/...`, `/home/...`, repo checkouts don't exist in
  the cloud env. Pass the script as inline source, a public/raw URL, or a file written into the
  job; never a path from this machine.
- **GPU preflight.** Before a full GPU submit (CUDA / bf16 / fp16 / quantization / flash-attn /
  torch.compile / model loading), smoke-test the exact imports + model-loading + training
  entrypoint on a tiny subset on small GPU hardware first. Fix failures before scaling up.

## Launching & monitoring (CLI)

- Launch a script: `hf jobs run <image> <command...>` or, for a Python-with-deps script,
  `hf jobs uv run --flavor <hw> --timeout 3h <script.py>`.
- Secrets: `HF_TOKEN` is auto-injected into job secrets — don't pass it yourself.
- Monitor: `hf jobs ps -a --format json` (list + state), `hf jobs inspect <id>`, `hf jobs logs <id>`.
- **After launching, record the job id on the experiment**: call `experiment_link_job` with the
  experiment id and the job id so the log tracks its status automatically.

## Hardware sizing (training)

| Model size | Flavor |
|-----------|--------|
| 1–3B  | `a10g-largex2` |
| 7–13B | `a100-large` |
| 30B+  | `l40sx4` or `a100x4` |
| 70B+  | `a100x8` |

`a10g-small` and `a10g-large` have the **same** 24GB GPU — they differ only in CPU/RAM.

## Performance & errors

- **Prefer Hub kernels over compiling flash-attn.** Don't `pip install flash-attn` (slow, often
  fails on the job's CUDA/torch combo). Use the `kernels` library and
  `attn_implementation="kernels-community/flash-attn2"` (or `vllm-flash-attn3`, `paged-attention`).
- **OOM:** reduce `per_device_train_batch_size` and raise `gradient_accumulation_steps`
  proportionally (keep effective batch size), enable `gradient_checkpointing=True`, or move to
  bigger hardware. Do **not** switch training method (SFT→LoRA) or cut `max_length` — that changes
  what the experiment measures.
- **Logging:** set `disable_tqdm=True`, `logging_strategy="steps"`, `logging_first_step=True` so
  loss prints as grep-able plain-text lines.

See the `trackio-monitoring` skill for live metrics, alerts, and dashboards.
