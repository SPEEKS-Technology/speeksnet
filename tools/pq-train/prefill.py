"""Picture Quality local model: prefill a labelling batch for Confirm Shots, for free.

    python tools/pq-train/prefill.py pick              # live listings → pick.json (read it, then:)
    python tools/pq-train/prefill.py run               # the local model on every picked photo → answers.json
    python tools/pq-train/prefill.py load              # answers.json → pq_local_prefill (0157)

All under C:\\Users\\User\\pq-train\\prefill-<date>\\ (PQ_BATCH=<dir> to pick another).

WHY (Ethan, 2026-10-22): More For Training ran dry, and an Opus grade to
prefill more costs ~$0.26 a listing. He chose the local model instead: round 4
(his labels only) answers each photo's shots, closeup and reflection, and he
corrects it in More For Training. NOTHING HERE COSTS MONEY OR CALLS CLAUDE:
listings and photos come from the PUBLIC storefronts and Shopify's own CDN
resize (never a Supabase /render/image/ transform), the model runs on the GPU,
and the rows go in through the Supabase CLI.

PICK: never graded (picture_quality_reviews), never labelled (pq_shot_labels),
not prefilled already, available, 3+ photos, sheet guessed from the TITLE (the
10-21 batch's rules, label-batch-20261021\\classify.py, widened to the sheets
round 4 still misses on). Weakest sheets first, CAPS per sheet. A title the
rules get wrong is fine: he can change the sheet in Confirm Shots.

RUN uses the same prompt, contact sheet and decoding as evaluate.py
(common.encode / read_answer, build_data.contact_sheet), so the prefill is
exactly what the scored model says.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_data  # noqa: E402

REPO = build_data.REPO
REF = "ejzaqmyxxrkmxvzbjeuo"
BATCH = os.environ.get("PQ_BATCH", os.path.join(r"C:\Users\User\pq-train", "prefill-" + time.strftime("%Y%m%d")))
ADAPTER = os.environ.get("PQ_ADAPTER", r"C:\Users\User\pq-train\runs\run-20261021-2247\adapter")
MODEL = os.environ.get("PQ_MODEL_NAME", "local-r4")
SHOP = {"OVL": "paymore-overland-park", "LEE": "paymore-lees-summit", "WSP": "paymore-westport",
        "MPL": "paymore-maplewood", "BAL": "paymore-ballwin"}

ACC = (r"\b(charger|adapter|case|sleeve|bag|backpack|battery|cable|cord|keyboard only|screen protector|replacement|"
       r"stand|dock|mount|skin|cover|power supply|ac adapter|controller|cap|hood|filter)\b")
GAMING = r"\b(rog|tuf|legion|omen|alienware|predator|nitro|katana|raider|stealth|blade|aorus|helios|scar|strix|victus|loq|rtx|gtx)\b"
GAME = r"\(([^()]*),\s*(19|20)\d\d\)\s*$"   # "Title (Platform, 2010)" = a video game
NEW = r"^\s*new\b"                           # new-in-box has its own sheet
# A whole computer: a CPU, RAM and storage in the title ("i7-13700H 32GB RAM 1TB SSD").
# Keeps "...GeForce RTX 4050" laptops and builds out of graphics-cards, and RAM
# sticks / drives / speakers that say "desktop" or "laptop" out of the computer sheets.
COMPUTER = r"\b(core (i\d|ultra)|i\d-\d{4}|ryzen|celeron|pentium|xeon|athlon|snapdragon|n\d{3,4}\b)"
PART = r"\b(sshd|speakers?|subwoofer|monitor)\b"
# In priority order: a title takes the FIRST sheet it matches. (sheet, rule, cap)
SHEETS = [
    # Not "2x Xeon" or "32X": a lot says so.
    ("item-lots", lambda t: re.search(r"^(lot\b|lot of)|\blot of \d+|\(\s*lot\s*\)|\bbundle of \d+", t, re.I)
                            and not re.search(GAME, t), 99),
    ("windows-laptops", lambda t: re.search(r"\b(laptop|notebook|thinkpad|latitude|elitebook|probook|inspiron|xps 1[3-7]|pavilion|"
                                            r"envy x?360|ideapad|yoga|surface laptop|surface pro|vivobook|zenbook|aspire|spectre|"
                                            r"swift|zbook|galaxy book)\b", t, re.I)
                                  and re.search(COMPUTER, t, re.I)
                                  and not re.search(GAMING + "|macbook|chromebook|desktop|" + ACC, t, re.I), 99),
    ("receivers-amplifiers", lambda t: re.search(r"\b(receiver|amplifier|amp|preamp|pre-amp|integrated amp|mono ?block)\b", t, re.I)
                                       and not re.search(r"\b(guitar|bass|headphone amp|wifi|bluetooth receiver|usb|wireless receiver|"
                                                         r"dongle|antenna|cable|graphics|egpu|speaker pair|combo)\b", t, re.I), 99),
    ("action-cameras", lambda t: re.search(r"\b(gopro|go pro|insta360|osmo action|osmo pocket|akaso|dji action)\b", t, re.I)
                                 and not re.search(ACC, t, re.I), 99),
    ("graphics-cards", lambda t: re.search(r"\b(geforce|rtx \d{4}|gtx \d{3,4}|radeon rx|rx \d{3,4}|arc a\d{3})\b", t, re.I)
                                 and re.search(r"graphics card|gddr\d", t, re.I)
                                 and not re.search(COMPUTER + r"|laptop|desktop|egpu|dock", t, re.I), 99),
    ("motherboards", lambda t: re.search(r"\bmotherboard\b|\bmain bd\b", t, re.I)
                               and not re.search(r"\b(case|chassis|power supply|psu)\b", t, re.I), 15),
    ("gaming-pcs", lambda t: re.search(r"\b(gaming pc|gaming desktop|custom pc)\b", t, re.I)
                             or (re.search(r"\b(desktop|tower)\b", t, re.I) and re.search(GAMING, t, re.I)), 15),
    ("windows-desktop", lambda t: re.search(r"\b(desktop|tower|optiplex|elitedesk|prodesk|thinkcentre|vostro)\b", t, re.I)
                                  and re.search(COMPUTER, t, re.I)
                                  and not re.search(GAMING + "|mac mini|imac|" + PART + "|" + ACC, t, re.I), 15),
    ("game-console", lambda t: re.search(r"\b(console|gaming system)\b", t, re.I)
                               and not re.search(r"switch|game ?boy|\bds\b|3ds|psp|vita|handheld|steam deck|rog ally|legion go|"
                                                 + ACC, t, re.I), 30),
    ("lenses", lambda t: re.search(r"\b(lens|\d+-\d+mm|\d+mm f/)\b", t, re.I)
                         and not re.search(r"\b(camera|dslr|mirrorless|camcorder|body only|bundle)\b|" + ACC, t, re.I), 20),
]


def db(sql):
    """One read or write through the Supabase CLI (already logged in): free."""
    path = os.path.join(BATCH, "q.sql")
    with open(path, "w", encoding="utf-8") as f:
        f.write(sql)
    p = subprocess.run(f'npx supabase db query --linked --project-ref {REF} --output-format json -f "{path}"',
                       shell=True, capture_output=True, text=True, encoding="utf-8", cwd=REPO)
    out = p.stdout[p.stdout.find("{"):]
    try:
        j = json.loads(out)
    except Exception:
        raise SystemExit(f"database call failed:\n{p.stdout}\n{p.stderr}")
    if "rows" not in j:
        raise SystemExit(f"database call failed: {out[:500]}")
    return j["rows"]


def storefront(store):
    """Every product on the store's public storefront, 250 a page."""
    out, page = [], 1
    while True:
        url = f"https://{SHOP[store]}.myshopify.com/products.json?limit=250&page={page}"
        req = urllib.request.Request(url, headers={"User-Agent": "speeksnet-pq-train"})
        with urllib.request.urlopen(req, timeout=60) as r:
            got = json.loads(r.read())["products"]
        if not got:
            return out
        for p in got:
            imgs = sorted(p.get("images") or [], key=lambda i: i.get("position") or 0)
            out.append({"store": store, "id": str(p["id"]), "title": p.get("title") or "",
                        "available": any(v.get("available") for v in p.get("variants") or []),
                        "photos": [{"url": i["src"], "w": i.get("width"), "h": i.get("height")} for i in imgs]})
        page += 1
        time.sleep(0.5)


def pick():
    os.makedirs(BATCH, exist_ok=True)
    snap = os.path.join(BATCH, "live.json")
    if os.path.exists(snap) and time.time() - os.path.getmtime(snap) < 6 * 3600:   # re-picking the same day
        live = json.load(open(snap, encoding="utf-8"))
        print(f"reusing {snap} ({len(live)} products)")
    else:
        live = []
        for st in SHOP:
            got = storefront(st)
            print(f"{st}: {len(got)} products", flush=True)
            live += got
        json.dump(live, open(snap, "w", encoding="utf-8"))
    seen = {r["id"] for r in db("select split_part(product_id,'/',-1) id from picture_quality_reviews "
                                "union select split_part(product_id,'/',-1) from pq_shot_labels "
                                "union select split_part(product_id,'/',-1) from pq_local_prefill")}
    cand = [p for p in live if p["available"] and len(p["photos"]) >= 3 and p["id"] not in seen
            and not re.search(NEW, p["title"], re.I) and not re.search(GAME, p["title"])]
    taken, chosen = set(), {}
    for sheet, rule, cap in SHEETS:
        hits = [p for p in cand if p["id"] not in taken and rule(p["title"])]
        # Spread across the stores: round-robin by store, oldest product id first.
        by = {}
        for p in sorted(hits, key=lambda p: int(p["id"])):
            by.setdefault(p["store"], []).append(p)
        order = [q for grp in zip(*[iter(v + [None] * len(hits)) for v in by.values()]) for q in grp if q]
        chosen[sheet] = order[:cap]
        taken |= {p["id"] for p in chosen[sheet]}
    json.dump(chosen, open(os.path.join(BATCH, "pick.json"), "w", encoding="utf-8"), indent=1)
    n = sum(len(v) for v in chosen.values())
    print(f"\npicked {n} listings, {sum(len(p['photos']) for v in chosen.values() for p in v)} photos → {BATCH}\\pick.json")
    for sheet, v in chosen.items():
        print(f"\n== {sheet}: {len(v)}")
        for p in v:
            print(f"   {p['store']} {p['id']:15} {len(p['photos']):2} photos  {p['title'][:80]}")


def run():
    import torch
    import common
    chosen = json.load(open(os.path.join(BATCH, "pick.json"), encoding="utf-8"))
    sheets = [s for s, v in chosen.items() if v]
    guide = {}
    for r in db("select c.slug, s.label from pg_categories c join pg_shots s on s.category_id = c.id "
                f"where c.slug in ({','.join(repr(s) for s in sheets)}) order by c.slug, s.sort_order"):
        guide.setdefault(r["slug"], [])
        if r["label"] not in guide[r["slug"]]:
            guide[r["slug"]].append(r["label"])
    contacts = os.path.join(BATCH, "contact")
    os.makedirs(contacts, exist_ok=True)
    os.makedirs(build_data.PHOTOS, exist_ok=True)
    jobs = {p["url"]: build_data.photo_path(p["url"]) for v in chosen.values() for l in v for p in l["photos"]}
    print(f"downloading {len(jobs)} photos at {build_data.WIDTH}px …", flush=True)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(6) as pool:
        ok = dict(zip(jobs, pool.map(lambda u: build_data.fetch(u, jobs[u]), jobs)))
    examples = []
    for sheet, v in chosen.items():
        for l in v:
            if not all(ok[p["url"]] for p in l["photos"]):
                print(f"  skipped {l['store']} {l['id']}: a photo would not download")
                continue
            for n, p in enumerate(l["photos"], 1):
                ex = {"id": f"{l['id']}#{n}", "product_id": f"gid://shopify/Product/{l['id']}", "n": n, "store": l["store"],
                      "sheet": sheet, "title": l["title"], "shots_on_sheet": guide[sheet], "pos": n, "of": len(l["photos"]),
                      "image": build_data.photo_path(p["url"]), "contact": os.path.join(contacts, f"{l['id']}_{n}.jpg"),
                      "src": p["url"].split("?")[0]}
                build_data.contact_sheet(l, n, ex["contact"])
                examples.append(ex)
    common.keep_awake(True)
    model, processor = common.load(ADAPTER)
    model.eval()
    t0 = time.time()
    with open(os.path.join(BATCH, "answers.jsonl"), "w", encoding="utf-8") as f:
        for i, ex in enumerate(examples):
            inputs = common.encode(processor, ex, with_answer=False).to(model.device)
            with torch.no_grad():
                ids = model.generate(**inputs, max_new_tokens=96, do_sample=False)
            text = processor.batch_decode(ids[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
            f.write(json.dumps({**ex, "raw": text, "pred": common.read_answer(text, ex)}) + "\n")
            if (i + 1) % 25 == 0:
                print(f"  {i + 1}/{len(examples)} · {(time.time() - t0) / (i + 1):.1f}s a photo", flush=True)
    common.keep_awake(False)
    print(f"\nanswers for {len(examples)} photos → {BATCH}\\answers.jsonl")


def load():
    by = {}
    for line in open(os.path.join(BATCH, "answers.jsonl"), encoding="utf-8"):
        r = json.loads(line)
        k = (r["store"], r["product_id"])
        by.setdefault(k, {"sheet": r["sheet"], "title": r["title"], "photos": []})["photos"].append(
            {"n": r["n"], "src": r["src"], "shots": r["pred"]["shots"],
             "closeup": r["pred"]["closeup"], "reflection": r["pred"]["reflection"]})
    q = lambda s: "'" + str(s).replace("'", "''") + "'"
    values = [f"({q(st)}, {q(pid)}, {q(v['sheet'])}, {q(v['title'])}, {q(MODEL)}, {q(json.dumps(sorted(v['photos'], key=lambda p: p['n'])))}::jsonb)"
              for (st, pid), v in by.items()]
    for i in range(0, len(values), 40):
        db("insert into pq_local_prefill (store_code, product_id, sheet_slug, title, model, photos) values "
           + ",\n".join(values[i:i + 40])
           + " on conflict (store_code, product_id) do update set sheet_slug = excluded.sheet_slug, title = excluded.title,"
             " model = excluded.model, photos = excluded.photos, created_at = now() returning product_id")
    print(f"loaded {len(values)} listings into pq_local_prefill")


if __name__ == "__main__":
    {"pick": pick, "run": run, "load": load}[sys.argv[1] if len(sys.argv) > 1 else "pick"]()
