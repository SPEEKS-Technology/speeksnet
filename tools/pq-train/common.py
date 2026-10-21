"""Shared by train.py and evaluate.py: one place for the prompt, the model load
and reading the model's answer, so training and testing can never drift apart.
See build_data.py for what an example is and why it's one photo."""
import json
import os
import re

import torch

ROOT = os.environ.get("PQ_ROOT", r"C:\Users\User\pq-train")
BASE = os.path.join(ROOT, "models", "Qwen2.5-VL-7B-Instruct")
DATA = os.path.join(ROOT, "data")
RUNS = os.path.join(ROOT, "runs")
# 640x640 ≈ 520 image tokens: enough to tell a cartridge's front from its back,
# small enough that a 7B model trains in 16 GB.
MIN_PIXELS, MAX_PIXELS = 128 * 28 * 28, 640 * 640
# The round-4 contact sheet (build_data.contact_sheet) is 448x448 ≈ 256 tokens.
CONTACT_PIXELS = 448 * 448
# Which round's prompt. 4 adds the contact sheet and the Extra rule; PQ_PROMPT=3
# reproduces round 3's prompt exactly, so its adapter can be re-scored fairly
# on a rebuilt test set.
PROMPT = int(os.environ.get("PQ_PROMPT", "4"))

SYSTEM = ("You label one photo from a used-electronics resale listing against the store's "
          "Picture Guide sheet for that kind of item. Answer with JSON only.")


def question(ex):
    shots = "; ".join(ex["shots_on_sheet"])
    # Round 3 (2026-10-18): the photo's position, when the example has it. One
    # photo alone can't tell "Side" from "Opposite Side" or one laptop corner from
    # another (round 2's worst sheet, Windows laptops, was 26%). Stores shoot
    # roughly in the sheet's order, so position is a strong, free hint.
    where = (f"This is photo {ex['pos']} of {ex['of']} in the listing. Stores usually shoot in the sheet's order, "
             "and rarely shoot the same view twice.\n") if ex.get("pos") and ex.get("of") else ""
    # Round 4 (2026-10-21): the second image is the whole listing, numbered, with
    # this photo outlined, so "the other corner" and "the side not shot yet" can be
    # seen instead of guessed from position.
    grid = ("The second image shows every photo in the listing, numbered in order; this photo is "
            f"number {ex['pos']}, outlined in yellow. Use the others to tell which view this one is.\n"
            ) if PROMPT >= 4 and ex.get("contact") else ""
    # Ethan's rule (2026-10-21), from re-checking the Skylanders and Tilta lots.
    # Only sheets that list "Extra Accessories" get its half: his labels never use it
    # elsewhere, so naming it on, say, new-in-box would invite an answer off the sheet.
    acc = (" \"Extra Accessories\" is a photo of something that came WITH the item (a laptop's charger)."
           if "Extra Accessories" in ex["shots_on_sheet"] else "")
    extra = ("Also allowed: \"Extra\" is another view of the item itself that the sheet doesn't ask for "
             "(the bottom of a gaming PC)." + acc + " \"Box\" is the packaging only.\n"
             if PROMPT >= 4 else
             "Also allowed: \"Extra\" (anything that is not one of the sheet's shots) and \"Box\" (the packaging only).\n")
    return (f"Listing: {ex['title']}\n"
            f"Sheet: {ex['sheet']}\n"
            f"Shots on this sheet, in the sheet's order: {shots}\n"
            + where + grid + extra +
            "Which shot is this photo? One photo can be two shots (a front view with the lens open is both).\n"
            "closeup: true for a tight detail shot that does not show the whole item.\n"
            "reflection: true when a reflection on the item is something a buyer would notice.\n"
            'Reply as JSON: {"shots": [...], "closeup": true|false, "reflection": true|false}')


def answer(ex):
    t = ex["target"]
    return json.dumps({"shots": t["shots"], "closeup": bool(t.get("closeup")), "reflection": bool(t.get("reflection"))})


def messages(ex, with_answer):
    content = [{"type": "image", "image": ex["image"], "min_pixels": MIN_PIXELS, "max_pixels": MAX_PIXELS}]
    if PROMPT >= 4 and ex.get("contact"):
        content.append({"type": "image", "image": ex["contact"], "min_pixels": MIN_PIXELS, "max_pixels": CONTACT_PIXELS})
    content.append({"type": "text", "text": question(ex)})
    m = [{"role": "system", "content": [{"type": "text", "text": SYSTEM}]},
         {"role": "user", "content": content}]
    if with_answer:
        m.append({"role": "assistant", "content": [{"type": "text", "text": answer(ex)}]})
    return m


def load(adapter=None, for_training=False):
    from transformers import AutoProcessor, BitsAndBytesConfig, Qwen2_5_VLForConditionalGeneration
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                               bnb_4bit_compute_dtype=torch.bfloat16)
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(BASE, quantization_config=quant, dtype=torch.bfloat16,
                                                               device_map={"": 0}, attn_implementation="sdpa")
    processor = AutoProcessor.from_pretrained(BASE, min_pixels=MIN_PIXELS, max_pixels=MAX_PIXELS)
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter, is_trainable=for_training)
    return model, processor


def encode(processor, ex, with_answer):
    from qwen_vl_utils import process_vision_info
    msgs = messages(ex, with_answer)
    text = processor.apply_chat_template(msgs, tokenize=False, add_generation_prompt=not with_answer)
    images, _ = process_vision_info(msgs)
    return processor(text=[text], images=images, return_tensors="pt")


def read_answer(text, ex):
    """The model's JSON, forgiving about code fences and stray words; shot names
    snapped to the sheet's own spelling when they match ignoring case."""
    m = re.search(r"\{.*\}", text, re.S)
    try:
        got = json.loads(m.group(0)) if m else {}
    except Exception:
        got = {}
    names = {s.lower(): s for s in ex["shots_on_sheet"] + ["Extra", "Box"]}
    shots = [names.get(str(s).strip().lower(), str(s).strip()) for s in (got.get("shots") or []) if str(s).strip()]
    return {"shots": shots, "closeup": bool(got.get("closeup")), "reflection": bool(got.get("reflection")),
            "valid": bool(m) and "shots" in got}


def rows(name):
    with open(os.path.join(DATA, f"{name}.jsonl"), encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def keep_awake(on=True):
    """Stop Windows from SLEEPING while a run is going (it does not stop a closed
    lid from sleeping the laptop, and changes no settings)."""
    try:
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))
    except Exception:
        pass
