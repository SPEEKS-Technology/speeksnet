"""Picture Quality local model: one overnight LoRA run, then score it.

    tools\\pq-train\\run-tonight.cmd          (what Ethan starts at bedtime)
    python tools/pq-train/train.py --epochs 3
    python tools/pq-train/train.py --fit-check   # 3 steps, nothing saved: does it fit in 16 GB?

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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--accum", type=int, default=8)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--fit-check", action="store_true")
    a = ap.parse_args()

    run = os.path.join(common.RUNS, ("fitcheck-" if a.fit_check else "run-") + time.strftime("%Y%m%d-%H%M"))
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
    model = get_peft_model(model, lora)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    say(f"run {run} · trainable {trainable / 1e6:.1f}M parameters · lr {a.lr} · rank {a.rank} · accum {a.accum}")

    train = common.rows("train")
    steps_per_epoch = math.ceil(len(train) / a.accum)
    total = 3 if a.fit_check else steps_per_epoch * a.epochs
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.0)
    warm = max(1, total // 20)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total))))
    say(f"{len(train)} photos · {steps_per_epoch} steps an epoch · {total} steps")

    model.train()
    step, t0 = 0, time.time()
    rng = random.Random(7)
    for epoch in range(1 if a.fit_check else a.epochs):
        order = train[:]
        rng.shuffle(order)
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
                    left = (time.time() - t0) / step * (total - step) / 60
                    say(f"epoch {epoch + 1} step {step}/{total} · loss {running / n:.3f} · peak GPU {mem:.1f} GB · ~{left:.0f} min left")
                    running, n = 0.0, 0
                if a.fit_check and step >= total:
                    say(f"FIT CHECK OK: {total} steps, peak GPU {torch.cuda.max_memory_allocated() / 2**30:.1f} GB "
                        f"of 16 · {(time.time() - t0) / total:.1f}s a step → a 3-epoch run ≈ "
                        f"{(time.time() - t0) / total * steps_per_epoch * 3 / 60:.0f} min")
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
