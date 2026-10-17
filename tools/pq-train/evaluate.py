"""Score the local model on the held-out photos, before or after training.

    python tools/pq-train/evaluate.py                       # the base model, untrained (the baseline)
    python tools/pq-train/evaluate.py --adapter runs/<run>/adapter
    python tools/pq-train/evaluate.py --sets test           # only Ethan's held-out quarter

Writes <out>/eval-<set>.jsonl (every answer) and prints, per set and per sheet:
shot labels exactly right, first shot right, closeup and reflection
precision/recall, and how often the answer was valid JSON.
  test     = Ethan's own labels on listings never trained on (the honest number)
  reviewed = Opus labels he let stand in his store reviews (a yardstick, not truth)
No network, no API; runs on the GPU only.
"""
import argparse
import json
import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def pr(tp, fp, fn):
    p = f"{100 * tp / (tp + fp):.0f}%" if tp + fp else "—"
    r = f"{100 * tp / (tp + fn):.0f}%" if tp + fn else "—"
    return f"P {p} R {r} ({tp + fn} real)"


def score(rows):
    by = {}
    for r in rows:
        for key in ("ALL", r["sheet"]):
            b = by.setdefault(key, {"n": 0, "exact": 0, "first": 0, "valid": 0,
                                    "closeup": [0, 0, 0], "reflection": [0, 0, 0]})
            want, got = r["target"], r["pred"]
            ws, gs = {s.lower() for s in want["shots"]}, [s.lower() for s in got["shots"]]
            b["n"] += 1
            b["valid"] += got["valid"]
            b["exact"] += ws == set(gs)
            b["first"] += bool(gs) and gs[0] in ws
            for k in ("closeup", "reflection"):
                if k not in want:
                    continue
                w, g = bool(want[k]), bool(got[k])
                b[k][0] += w and g
                b[k][1] += g and not w
                b[k][2] += w and not g
    return by


def report(name, rows, out):
    by = score(rows)
    lines = [f"\n{name.upper()} — {len(rows)} photos"]
    for key in ["ALL"] + sorted((k for k in by if k != "ALL"), key=lambda k: -by[k]["n"]):
        b = by[key]
        lines.append(f"  {key[:34]:34} {b['n']:4}  shots exact {100 * b['exact'] / b['n']:3.0f}%  first {100 * b['first'] / b['n']:3.0f}%"
                     f"  valid {100 * b['valid'] / b['n']:3.0f}%"
                     + (f"  closeup {pr(*b['closeup'])}  reflection {pr(*b['reflection'])}" if key == "ALL" else ""))
    text = "\n".join(lines)
    print(text, flush=True)
    with open(os.path.join(out, "scores.txt"), "a", encoding="utf-8") as f:
        f.write(text + "\n")
    return by["ALL"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--sets", default="test,reviewed")
    ap.add_argument("--out", default=None)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    out = a.out or (os.path.dirname(a.adapter) if a.adapter else os.path.join(common.RUNS, "baseline-" + time.strftime("%Y%m%d-%H%M")))
    os.makedirs(out, exist_ok=True)
    common.keep_awake(True)
    model, processor = common.load(a.adapter)
    model.eval()
    for name in a.sets.split(","):
        rows = common.rows(name)[: a.limit or None]
        t0, done = time.time(), []
        with open(os.path.join(out, f"eval-{name}.jsonl"), "w", encoding="utf-8") as f:
            for i, ex in enumerate(rows):
                inputs = common.encode(processor, ex, with_answer=False).to(model.device)
                with torch.no_grad():
                    ids = model.generate(**inputs, max_new_tokens=96, do_sample=False)
                text = processor.batch_decode(ids[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
                ex = {**ex, "raw": text, "pred": common.read_answer(text, ex)}
                done.append(ex)
                f.write(json.dumps(ex) + "\n")
                if (i + 1) % 25 == 0:
                    print(f"  {name}: {i + 1}/{len(rows)} · {(time.time() - t0) / (i + 1):.1f}s a photo", flush=True)
        report(name, done, out)
    common.keep_awake(False)
    print(f"\nanswers and scores in {out}")


if __name__ == "__main__":
    main()
