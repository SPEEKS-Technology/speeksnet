"""Picture Quality local model: one overnight LoRA run, then score it.

    tools\\pq-train\\run-tonight.cmd          (what Ethan starts at bedtime)
    python tools/pq-train/train.py --epochs 3
    python tools/pq-train/train.py --fit-check   # 3 steps, nothing saved: does it fit in 16 GB?
    python tools/pq-train/train.py --resume runs/<run> --done 2   # finish a run that died after epoch 2

RESUME (2026-10-24): round 5 died at step 1240 of 1278 — paused for Ethan, then
the laptop slept and the frozen CUDA process didn't survive it. Starting over
is 10.5 h; the last epoch alone is ~3 h. --resume picks up the run's saved
adapter (written after every epoch) and trains only the epochs left, in the
SAME run folder, as close to the unbroken run as can be had:
  - the shuffle is seeded (Random(7)), so the skipped epochs' shuffles are
    replayed and the next epoch sees the photos in the order it would have;
  - the cosine schedule is a function of the step, so it carries on from
    step done×steps_per_epoch at the rate it would have had;
  - AdamW's moments were never saved, so the first steps re-warm (RE_WARM)
    while they rebuild instead of taking full-size steps on fresh moments.
The epoch-N adapter is copied to adapter-epochN first, so a second failure
can't cost it. Refuses to run if train.jsonl changed since the run started:
the replayed order would then be a different order. --fit-check with --resume
does 3 resumed steps and saves nothing (the loss should start near the dead
run's last loss, ~0.02, not a fresh adapter's ~0.5).

QLoRA on Qwen2.5-VL 7B: the base model is loaded in 4-bit and frozen, and a small
adapter (LoRA, ~40M parameters) is trained on the LANGUAGE side only. The vision
encoder stays as Qwen shipped it: 397 photos are far too few to retrain how it
sees, and plenty to teach it the store's shot names. Loss is on the answer
tokens only, never on the prompt.

Trains on train.jsonl (Ethan's own labels, see build_data.py). When it ends it
scores the adapter on test.jsonl (his held-out quarter) and reviewed.jsonl (the
Opus labels he let stand), the same way evaluate.py scores the base model, so
the morning result is one before-and-after comparison.

Everything goes to runs/<date-time>/: train.log, adapter/ (after every epoch,
the last one wins), eval-*.jsonl and scores.txt. Windows is kept from SLEEPING
while it runs (a closed lid still sleeps the laptop; see run-tonight.cmd).
"""
import argparse
import math
import os
import random
import subprocess
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

RE_WARM = 20   # optimizer steps to re-warm a resumed run (see RESUME above)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--accum", type=int, default=8)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--fit-check", action="store_true")
    ap.add_argument("--resume", default=None, help="a run folder whose adapter/ holds the last finished epoch")
    ap.add_argument("--done", type=int, default=0, help="with --resume: how many epochs that adapter finished")
    a = ap.parse_args()
    if a.resume:
        a.resume = os.path.abspath(a.resume if os.path.isabs(a.resume) else os.path.join(common.ROOT, a.resume))
        if not os.path.isfile(os.path.join(a.resume, "adapter", "adapter_model.safetensors")):
            raise SystemExit(f"no adapter in {a.resume}")
        if not 1 <= a.done < a.epochs:
            raise SystemExit(f"--done must be 1..{a.epochs - 1}")
        # A train.jsonl newer than the run folder means the data was rebuilt since.
        if os.path.getmtime(os.path.join(common.DATA, "train.jsonl")) > os.path.getctime(a.resume):
            raise SystemExit("train.jsonl changed since this run started: its order can't be replayed")
        if f"epoch {a.done} done" not in open(os.path.join(a.resume, "train.log"), encoding="utf-8").read():
            raise SystemExit(f"{a.resume}\\train.log never says 'epoch {a.done} done'")

    run = (a.resume if a.resume and not a.fit_check else
           os.path.join(common.RUNS, ("fitcheck-" if a.fit_check else "run-") + time.strftime("%Y%m%d-%H%M")))
    os.makedirs(run, exist_ok=True)
    log = open(os.path.join(run, "train.log"), "a", encoding="utf-8")

    def say(msg):
        line = time.strftime("%H:%M:%S ") + msg
        print(line, flush=True)
        log.write(line + "\n")
        log.flush()

    common.keep_awake(True)
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    model, processor = common.load()
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    lora = LoraConfig(r=a.rank, lora_alpha=2 * a.rank, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                      # language-model layers only; the vision tower (model.visual) stays frozen
                      target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)")
    if a.resume:
        import shutil
        from peft import PeftModel
        keep = os.path.join(a.resume, f"adapter-epoch{a.done}")
        if not a.fit_check and not os.path.exists(keep):
            shutil.copytree(os.path.join(a.resume, "adapter"), keep)
        model = PeftModel.from_pretrained(model, os.path.join(a.resume, "adapter"), is_trainable=True)
    else:
        model = get_peft_model(model, lora)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    say(f"run {run} · trainable {trainable / 1e6:.1f}M parameters · lr {a.lr} · rank {a.rank} · accum {a.accum}")

    train = common.rows("train")
    steps_per_epoch = math.ceil(len(train) / a.accum)
    total = steps_per_epoch * a.epochs
    first = steps_per_epoch * a.done   # optimizer steps already taken (0 unless resuming)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.0)
    warm = max(1, total // 20)
    # s counts this process's steps; the schedule runs on the run's own step count.
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (first + s + 1) / warm, (s + 1) / RE_WARM if first else 1.0)
                                              * 0.5 * (1 + math.cos(math.pi * min(1.0, (first + s) / total))))
    say(f"{len(train)} photos · {steps_per_epoch} steps an epoch · {total} steps"
        + (f" · RESUMED after epoch {a.done} at step {first} · lr now {opt.param_groups[0]['lr']:.2e}, "
           f"re-warming over {RE_WARM} steps" if first else ""))
    # Where to stop. Not `total`: the schedule reads that at every step.
    stop = first + 3 if a.fit_check else total

    model.train()
    step, t0 = first, time.time()
    rng = random.Random(7)
    for epoch in range(a.epochs):
        order = train[:]
        rng.shuffle(order)
        if epoch < a.done:
            continue   # replayed only for the shuffle: this epoch is in the adapter already
        running, n = 0.0, 0
        for i, ex in enumerate(order):
            full = common.encode(processor, ex, with_answer=True)
            prompt_len = common.encode(processor, ex, with_answer=False)["input_ids"].shape[1]
            labels = full["input_ids"].clone()
            labels[:, :prompt_len] = -100
            full = {k: v.to(model.device) for k, v in full.items()}
            loss = model(**full, labels=labels.to(model.device)).loss / a.accum
            loss.backward()
            running += loss.item() * a.accum
            n += 1
            if (i + 1) % a.accum == 0 or i + 1 == len(order):
                torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
                opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
                step += 1
                if step % 5 == 0 or a.fit_check:
                    mem = torch.cuda.max_memory_allocated() / 2**30
                    left = (time.time() - t0) / (step - first) * (stop - step) / 60
                    say(f"epoch {epoch + 1} step {step}/{total} · loss {running / n:.3f} · peak GPU {mem:.1f} GB · ~{left:.0f} min left")
                    running, n = 0.0, 0
                if a.fit_check and step >= stop:
                    each = (time.time() - t0) / (step - first)
                    say(f"FIT CHECK OK: {step - first} steps, peak GPU {torch.cuda.max_memory_allocated() / 2**30:.1f} GB "
                        f"of 16 · {each:.1f}s a step → {a.epochs - a.done} epoch(s) ≈ "
                        f"{each * steps_per_epoch * (a.epochs - a.done) / 60:.0f} min · lr {opt.param_groups[0]['lr']:.2e}")
                    common.keep_awake(False)
                    return
        model.save_pretrained(os.path.join(run, "adapter"))
        say(f"epoch {epoch + 1} done · adapter saved")

    say(f"training done in {(time.time() - t0) / 60:.0f} min · scoring it")
    del model, opt
    torch.cuda.empty_cache()
    log.close()
    # Scored in a fresh process: a clean GPU, and the same code path as the baseline.
    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "evaluate.py"),
                    "--adapter", os.path.join(run, "adapter")], check=False)
    common.keep_awake(False)


if __name__ == "__main__":
    main()
