"""Picture Quality local model: build the per-photo training and test files.

    C:\\Users\\User\\pq-train\\.venv\\Scripts\\python.exe tools/pq-train/build_data.py

Reads scripts/pq-gold/gold.json (made by scripts/pq-gold/export.mjs) and writes,
into C:\\Users\\User\\pq-train\\data:
    photos/<hash>.jpg   each photo once, 640px wide (Shopify's own CDN resize,
                        never a Supabase /render/image/ transform)
    train.jsonl         Ethan's own labels, about 3/4 of his listings
    test.jsonl          the other 1/4 of his listings, never trained on
    reviewed.jsonl      photos from grades he passed over in his store reviews:
                        Opus's labels he let stand, used ONLY to measure, never to train

WHY ONLY HIS LABELS (Ethan, 2026-10-16): Anthropic's terms restrict training
models on Claude's output, so training uses only the shots and flags he
confirmed himself in Confirm Shots (pq_shot_labels, tier "explicit"). Opus's
grades stay a yardstick (reviewed.jsonl) and are never training material.

ONE PHOTO PER EXAMPLE: a 7B vision model with a whole listing (up to 30
photos) won't train in 16 GB. One photo plus the sheet's shot list is the job
the model actually has to do. Missing shots then follow in code from the labels,
the way rules.ts already works. Repeats and the listing-level facts need
several photos at once, so they wait for a later round, and so does FRAMING
(Ethan: nail everything else first).

THE TARGET is what Ethan answered: the shot(s), closeup (the model's
whole_item = false) and reflection. Only photos whose flags he checked
(flags_checked, 0149) are used, so a blank flag is a real "no".

THE SPLIT is by LISTING, never by photo: two photos of one listing on both
sides would leak. It is stable: a listing's side comes from a hash of its id,
so re-running never moves a test listing into training.
"""
import hashlib
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GOLD = os.path.join(REPO, "scripts", "pq-gold", "gold.json")
OUT = os.environ.get("PQ_DATA", r"C:\Users\User\pq-train\data")
PHOTOS = os.path.join(OUT, "photos")
CONTACTS = os.path.join(OUT, "contact")   # round 4: one listing grid per example
CONTACT_PX = 448
WIDTH = 640
TEST_SHARE = 0.25
REVIEWED_MAX = 600   # enough to measure on; each costs inference time
# Labels KNOWN to be wrong that can't be fixed in Confirm Shots (2026-10-22):
# broken by the pre-10-14 reorder bug (see REDO in picture-quality index.ts)
# and sold before Ethan could re-check them, so the queue can't show them.
KNOWN_BAD = {
    "15228962308198",   # OVL Dell WD19S Docking Station (labels shifted; sold)
}


def side(product_id: str) -> str:
    h = int(hashlib.sha1(product_id.encode()).hexdigest(), 16) % 1000
    return "test" if h < TEST_SHARE * 1000 else "train"


def shot_list(listing):
    seen, out = set(), []
    for s in listing.get("guide") or []:
        if s["label"] not in seen:
            seen.add(s["label"])
            out.append(s["label"])
    return out


def sized(url: str) -> str:
    return url + ("&" if "?" in url else "?") + f"width={WIDTH}"


def fetch(url: str, path: str) -> bool:
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return True
    for attempt in range(3):
        try:
            req = urllib.request.Request(sized(url), headers={"User-Agent": "speeksnet-pq-train"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            with open(path, "wb") as f:
                f.write(data)
            return True
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return False


def example(listing, photo, path, tier):
    target = {"shots": photo["shots"]}
    if tier == "explicit":
        flags = set(photo.get("flags") or [])
        target["closeup"] = "closeup" in flags
        target["reflection"] = "reflection" in flags
    return {
        "id": f"{listing['product_id'].split('/')[-1]}#{photo['n']}",
        "product_id": listing["product_id"], "n": photo["n"], "store": listing["store"],
        "sheet": listing["sheet"], "title": listing.get("title") or "", "shots_on_sheet": shot_list(listing),
        # Where the photo sits in the listing (round 3, 2026-10-18). One photo alone
        # can't tell "Side" from "Opposite Side", or one laptop corner from another,
        # and those were round 2's worst misses (Windows laptops 26%). Stores shoot
        # in the guide's order, so position is a strong, free hint.
        "pos": photo["n"], "of": len(listing["photos"]),
        "image": path, "target": target, "tier": tier,
    }


def photo_path(url: str) -> str:
    return os.path.join(PHOTOS, hashlib.sha1(url.split("?")[0].encode()).hexdigest()[:20] + ".jpg")


def contact_sheet(listing, n, out):
    """Round 4 (2026-10-21): the whole listing as ONE small numbered grid, this
    photo outlined in yellow. Position alone (round 3) didn't move Windows laptops
    (26%): the model still can't see which corner it's on without the others. A
    grid is one fixed-size image (CONTACT_PX square, ~256 image tokens) however many
    photos the listing has (up to 38), so a 30-photo item lot costs no more memory
    than a 2-photo game. Built from TODAY's photos, all of them, labelled or not."""
    from PIL import Image, ImageDraw, ImageFont
    urls = [p["url"] for p in listing["photos"] if p.get("url")]
    cols = math.ceil(math.sqrt(len(urls)))
    nrows = math.ceil(len(urls) / cols)
    tile = CONTACT_PX // max(cols, nrows)
    sheet = Image.new("RGB", (CONTACT_PX, CONTACT_PX), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=max(10, tile // 5))
    for i, url in enumerate(urls):
        x, y = (i % cols) * tile, (i // cols) * tile
        try:
            im = Image.open(photo_path(url)).convert("RGB")
            im.thumbnail((tile - 6, tile - 6))
            sheet.paste(im, (x + (tile - im.width) // 2, y + (tile - im.height) // 2))
        except Exception:
            pass
        if i + 1 == n:
            draw.rectangle([x + 1, y + 1, x + tile - 2, y + tile - 2], outline=(255, 200, 0), width=max(3, tile // 18))
        draw.rectangle([x + 2, y + 2, x + 2 + tile // 4, y + 2 + tile // 5], fill="black")
        draw.text((x + 4, y + 2), str(i + 1), fill="white", font=font)
    sheet.save(out, quality=88)


def main():
    gold = json.load(open(GOLD, encoding="utf-8"))
    os.makedirs(PHOTOS, exist_ok=True)
    jobs, rows, listings = [], {"train": [], "test": [], "reviewed": []}, {}
    for l in gold["listings"]:
        if not l.get("sheet") or not l.get("guide"):
            continue
        if l["product_id"].split("/")[-1] in KNOWN_BAD:
            continue
        for p in l["photos"]:
            tier = p.get("shots_tier")
            if not p.get("shots") or not p.get("url"):
                continue
            if tier == "explicit" and not p.get("flags_checked"):
                continue
            if tier not in ("explicit", "reviewed"):
                continue
            path = photo_path(p["url"])
            bucket = side(l["product_id"]) if tier == "explicit" else "reviewed"
            rows[bucket].append(example(l, p, path, tier))
            jobs.append((p["url"], path))
            # Every photo of the listing, for its contact sheet.
            jobs += [(q["url"], photo_path(q["url"])) for q in l["photos"] if q.get("url")]
            listings[l["product_id"]] = l
    # The reviewed yardstick is capped, spread across sheets in a stable order.
    rows["reviewed"].sort(key=lambda r: hashlib.sha1(r["id"].encode()).hexdigest())
    rows["reviewed"] = rows["reviewed"][:REVIEWED_MAX]
    keep = {r["image"] for b in rows.values() for r in b}
    keep |= {photo_path(q["url"]) for r in (r for b in rows.values() for r in b)
             for q in listings[r["product_id"]]["photos"] if q.get("url")}
    jobs = [j for j in dict(jobs).items() if j[1] in keep]
    print(f"downloading {len(jobs)} photos at {WIDTH}px …", flush=True)
    with ThreadPoolExecutor(6) as pool:
        ok = list(pool.map(lambda j: fetch(*j), jobs))
    bad = {path for (url, path), good in zip(jobs, ok) if not good}
    os.makedirs(CONTACTS, exist_ok=True)
    for b in rows.values():
        for r in b:
            r["contact"] = os.path.join(CONTACTS, f"{r['id'].replace('#', '_')}.jpg")
            contact_sheet(listings[r["product_id"]], r["n"], r["contact"])
    for name, b in rows.items():
        b = [r for r in b if r["image"] not in bad]
        with open(os.path.join(OUT, f"{name}.jsonl"), "w", encoding="utf-8") as f:
            for r in b:
                f.write(json.dumps(r) + "\n")
        sheets = {}
        for r in b:
            sheets[r["sheet"]] = sheets.get(r["sheet"], 0) + 1
        print(f"{name}: {len(b)} photos from {len({r['product_id'] for r in b})} listings · "
              + ", ".join(f"{k} {v}" for k, v in sorted(sheets.items(), key=lambda x: -x[1])[:6]))
    if bad:
        print(f"⚠ {len(bad)} photos could not be downloaded and were left out", file=sys.stderr)


if __name__ == "__main__":
    main()
