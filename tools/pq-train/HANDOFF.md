# Handoff: Picture Quality local model (as of 2026-10-21)

## ⚡⚡⚡ ROUND 4 RESULT (2026-10-22, `runs\run-20261021-2247`) — 65% → 76%

Started 10-21 22:47 with Ethan's go; 963 steps at ~26 s, training done 05:51, scored
by 06:22; the laptop then shut itself down (`C:\Users\User\pq-train\finish-and-shutdown.ps1`,
only when scores.txt exists). TEST 717 photos (same set as the 65% re-score):
**shots exact 65% → 76%, first 71% → 79%**; closeup P90 R81 (was P93 R77); reflection
P82 R53 (was P85 R50). By sheet (round 3 → 4): Windows laptops 61→65, misc 47→62,
receivers 52→82, GPUs 47→71, action cams 56→78, item lots 18→41, MacBooks 66→81,
gaming laptops 71→79, headphones 74→87, Android phones 70→80, lenses 67→75,
handheld consoles 70→100, RAM 55→91; console flat 75; motherboards 57 flat. Reviewed
yardstick 92%. Still the weakest: item lots 41, misc 62, Windows laptops 65.
Gain is confounded (more labels AND the contact sheet). Go-live bar is ~90–95%.

## ⚡⚡ Round 4 setup (2026-10-21 evening)

- **Labelling DONE:** 113 of the 114 (112 graded + Skylanders + Tilta), all flags checked.
  The one skipped is a Wii yoga game (`8596398702765`) the title sort put on Windows
  laptops. `pq_shot_labels`: 436 listings / 3,303 photos.
- **Data rebuilt** (gold.sql → export.mjs → build_data.py): train 2,566 photos / 334
  listings, test 717 / 95, reviewed 159. All 73 old test listings stayed in test, none
  moved to train. Round 3's jsonl kept in `data\round3-jsonl\`.
- **Round 3 re-scored on the NEW test set** (`runs\rescore-round3-newtest`): **65%**
  shots exact, first 71%; closeup P93 R77; reflection P85 R50. Windows laptops **61%**
  on 114 photos (the old 26% was 2 listings), misc 47, receivers 52, GPUs 47, action cams
  56, item lots 18. **This 65% is the bar for round 4**, not the 66% on the old set.
- **Round 4 code:** `build_data.contact_sheet` draws one 448px numbered grid of ALL the
  listing's photos per example (this one outlined yellow) into `data\contact\`;
  `common.messages` adds it as a second image and `common.question` says what it is,
  plus Ethan's Extra / Extra Accessories / Box rule. `PQ_PROMPT=3` gives round 3's prompt
  exactly (for re-scoring old adapters on rebuilt data).
- **Fit-check OK:** peak 11.1 GB of 16, **28.2 s a step**, 321 steps an epoch →
  3 epochs ≈ 7.5 h + ~35 min scoring ≈ **8 h**. Chose 3 epochs (same as rounds 2–3).
  `keep-awake.ps1` cap raised 7 → 10 h. `runs\tonight.log` already renamed to
  `tonight-round3.log`. `runs\baseline` is from the OLD test set and run-tonight
  skips it — fine, the round-3 re-score is the comparison.
- **Round 4's gain is confounded:** it has +46% more training photos AND the contact
  sheet. If it helps a lot and we want to know which, train round 3's prompt on the new
  data (`PQ_PROMPT=3`) another night.

## ⚡ Latest (2026-10-21) — read this first; it supersedes "Next step" below

- **Labelling status (checked 10-21 afternoon): NOT STARTED.** 0 of the 112 graded
  listings had rows in `pq_shot_labels`. Skylanders (`8161660960870`, 38 photos) and Tilta
  (`15873101529254`, 10 photos) still had only their 10-17 labels. The table stood at 325
  listings / 2,276 photos, with the last save 10-17 22:34 UTC. Re-check before step 3: join
  `pick.json`'s ids against `split_part(product_id,'/',-1)`.
- **Un-park is APPLIED in the working copy** (`speeks.js` catalog line un-commented; the
  stash is gone — it was applied at 11:35). `git diff speeks.js` should show ONLY that
  one line. The untracked `scripts/pq-gold/gold*.json` came back at the same time (old
  data, rebuilt by the re-export).
- **Repeat can now name ANY other photo** (`12e81be`, Ethan 10-21: "photo 6 is a worse
  version of photo 7"). `repeat_of` marks the copy that should GO, which isn't always
  the later one. Both pickers plus `saveShots` changed. The model's `repeats` and rules.ts
  are unchanged (earlier-only). picture-quality deployed, live == repo byte for byte.
  Cache-buster `20261021a`. Committed WITHOUT the un-park line (staged with
  `git apply --cached -R` of that one hunk) — do the same for any speeks.js commit while
  he labels.
- **NO SPENDING without Ethan's yes (10-21, after the $28.76 batch):** before ANY paid
  call, say what it is, how many listings, and the cost at ~$0.25–0.30 a listing; a yes
  covers that one run only. Guards checked 10-21: `PQ_NIGHTLY_PAUSED=1` (the secret's digest
  is sha256("1")); no picture-quality batch since 10-16 08:30 UTC; 0 pq_batches in flight.
  **Check Again** in the PQ store queue spends ~$0.26 in ONE click with no confirm —
  Ethan chose to leave it that way.
- **Closeup is a fact, not a problem** (Ethan asked): = the model's `whole_item: false`.
  It exempts the photo from cut_off, lets it cover a serial/closeup shot, keeps it from
  being a repeat of its face, and leaves it out of the setup grouping.
- **Deploy/compare without the MCP:** `npx supabase functions download picture-quality
  --project-ref ejzaqmyxxrkmxvzbjeuo --workdir <scratch dir> --use-api`, then `cmp` with
  `\r` stripped against the repo (or `git show HEAD:` before a deploy). Deploy:
  `npx supabase functions deploy picture-quality --no-verify-jwt --project-ref ejzaqmyxxrkmxvzbjeuo --use-api`.
  DB reads: `npx supabase db query --linked --project-ref ejzaqmyxxrkmxvzbjeuo --output-format json "<sql>"`.
  `ai_usage_log` columns are `at, tool, cost_usd, …` (not created_at).

- **Round 3 RAN** (run `C:\Users\User\pq-train\runs\run-20261020-2306`, finished 02:38).
  Shots exactly right **58% → 66%**, main shot 64% → 72%. Closeup P92 R70, reflection P81 R57.
  Up: console 57→75, new-in-box 54→77, misc 34→47, receivers 33→43, headphones 53→73,
  earbuds 75→100. **Flat: Windows laptops 26, item lots 12.** Slight dips (noise, small n):
  gaming PCs 72→67, gaming laptops 78→72, MacBooks 69→66.
  - Windows-laptop misses: in one of only 2 test listings the store shot out of the sheet's
    order and the model followed the SLOT, not the picture; corners still confused.
  - An earlier round-3 attempt (10-20 13:41) died in a Windows bugcheck 0x00020001
    (hypervisor) at step 325 while Ethan was using the laptop; kept as
    `run-20261020-1341-crashed`. The rerun with the laptop idle was clean at ~17 s/step.
    train.py has NO resume. If it crashes again while IDLE, suspect the NVIDIA driver.
  - **Before any run, rename `runs\tonight.log`** (e.g. tonight-roundN.log):
    keep-awake.ps1 exits as soon as that file contains "overnight run finished".
- **Extra vs Extra Accessories (Ethan's rule):** Extra = another view of the item itself
  that the guide doesn't ask for (bottom of a gaming PC). Extra Accessories = a photo of
  something that came WITH the item (a laptop's charger). Put this wording into
  `common.question` for round 4.
- **More For Training ran dry:** every Opus-graded listing is confirmed (325). Only ~407
  of ~4,000 live listings were ever graded. To get more labels on the weak sheets, Ethan
  **approved (~$15) grading 112 never-graded live listings** chosen by title:
  35 Windows laptops, 20 misc, 17 receivers, 14 action cameras, 10 GPUs, 9 item lots,
  7 Android phones → `C:\Users\User\pq-train\label-batch-20261021\pick.json`
  (`{sheet: [{store, id, title, photos}]}`; `classify.py` built it from `live.json`).
  **DONE 2026-10-21: all 112 graded and saved, 0 errors, $28.76 total** (Opus 5.5,
  medium; the function's own count, also logged in `ai_usage_log`). That's ~$0.26 a
  listing, not the ~$0.12 estimated: 15–16-photo Windows laptops that come back
  "reorder" cost ~$0.38 each (~71k input tokens). After the one-call cost check ($3.34
  for 12), Ethan approved going past the ~$15. **Budget ~$0.25–0.30 a listing** for any
  future batch on the live path (batchSweep, ≈ half price, can't target ids).
  Records in `C:\Users\User\pq-train\label-batch-20261021\`: `grade.mjs` (the live ids
  path, `?secret=…&store=XXX&ids=<≤12>&save=1` with the anon key, 12 ids a call grouped
  by store; `--calls N` limits it), `done.json` (every graded id with its verdict and
  cost; a re-run skips them), `responses\` (each call's full answer), `grade-rest.log`.
  The graded listings now wait pre-filled in More For Training.
- **Skylanders + Tilta item lots reopened** for an Extra/Extra Accessories re-check:
  `REDO` const in picture-quality index.ts; they prefill from Ethan's own saved labels
  and drop out once re-saved. **picture-quality is deployed at `0fd7e4c`** (live == repo).
- **⚠️ Picture Quality is PARKED in the front end since v3.9.3** (606c4f1: the
  `ec-view-picture-quality` FEATURE_CATALOG line commented out, for everyone). It is
  **un-commented in the WORKING COPY ONLY** so Ethan can label on the local site.
  **Never commit that line** — re-comment it (so `git diff speeks.js` is empty) when he
  is done labelling, before any commit that touches speeks.js.
- **The clueless-closet helper is off** since round 3; it comes back at next sign-in, or
  `pythonw.exe helper.py run` in `C:\Users\User\Projects\clueless-closet\render` (.venv).
- **Plan from here:** (1) ~~grade the 112 listings~~ done 10-21; (2) he labels them in More
  For Training plus the 2 reopened lots; (3) re-export gold (`gold.sql` → `export.mjs`) and
  `build_data.py` — new listings may land in TEST, so re-score round 3's adapter on the new
  test set for a fair comparison; (4) build **round 4: thumbnails of the listing's other
  photos** in the prompt + the Extra rule, fit-check it on the GPU (must stay under 16 GB);
  (5) Ethan says go → overnight run.

Paste this into a new Claude Code session opened on the `speeksnet` repo. It covers
what has been built, the decisions behind it, where things stand, and what comes next.

## The goal

SPEEKSNET's **Picture Quality** tool (Listing Health → Picture Quality) grades listing
photos against the store's Picture Guide. Today Claude Opus 5.5 does the *looking*
(which shot each photo is, closeups, reflections, framing…), and
`supabase/functions/picture-quality/rules.ts` does the *deciding* (score, pass/flag,
reorder, delete). The aim is to replace the paid Opus "looking" with a
**self-hosted, LoRA-fine-tuned vision model** (Qwen2.5-VL 7B) on Ethan's laptop
(RTX 5080 Laptop GPU, 16 GB). rules.ts stays as it is.

## Decisions Ethan has made (don't reopen them without him)

- **Train on HIS labels only, never on Opus's output.** He chose this because Anthropic's
  terms restrict training models on Claude output. Opus grades are used only as a
  yardstick to *measure* against.
- **Framing is deferred.** Crooked, off-centre, too small and cut off come later, as
  their own photo-by-photo labelling pass (the retired "Train The Checker",
  `pqTrainOpen` in speeks.js, can be revived). For now: shots, closeup, reflection,
  then repeats and listing facts.
- **Go-live bar:** about 90–95% across the board (framing included, eventually), then
  a shadow run next to Opus, then switch over one sheet at a time with Opus as the
  fallback. Whether Opus stays at all, even as a ~5% spot-check, is decided after
  training. After go-live: retrain on a schedule from triaged feedback, gated by a
  FROZEN test set. Never train online.
- **Ethan starts overnight training himself** (or explicitly tells Claude to start
  it). Never start training unasked. He labels from the **local site**, and the
  branch is **not merged to main** until the product is finished.
- **No paid model calls or re-grades** unless he asks. Fixes to picture-quality may be
  committed and deployed freely (deploy with `npx supabase functions deploy
  picture-quality --project-ref ejzaqmyxxrkmxvzbjeuo --use-api`). Before deploying,
  byte-compare the live copy against the last deployed commit; after deploying,
  byte-compare it against the repo.

## Where things are

- **Branch:** `Main-November-Update-2---Ethan`. HEAD is `86af7fc`, 16 commits ahead of
  origin, **not pushed**. Not merged to main.
- **Deployed:** the picture-quality edge function is at `9478c1d`.
- **Database migrations applied:** `0148_pq_shot_labels` (table) and
  `0149_pq_shot_labels_flags`. The next migration number is 0150; check with
  `ls supabase/migrations | sort | tail -1`.
- **Labelling UI** (speeks.js, DM/CEO only): Picture Quality → **Confirm Shots** (photos
  never judged) and **More For Training** (listings he passed in store reviews,
  weakest sheets first). Both save to `pq_shot_labels`. Run the local site with
  `python scripts/serve-local.py` (no caching), then open http://localhost:8080.
- **Labels so far:** about 325 listings / 2,276 photos confirmed by Ethan
  (`pq_shot_labels`, `flags_checked = true` for most).
- **Gold set and scorer:** `scripts/pq-gold/`. The flow is `gold.sql` → `export.mjs` →
  `score.mjs`; each file's header explains it. Re-export with:
  `npx supabase db query --linked --project-ref ejzaqmyxxrkmxvzbjeuo -f scripts/pq-gold/gold.sql --output-format json`
  then save the `rows` array as `scripts/pq-gold/gold-raw.json` and run
  `node scripts/pq-gold/export.mjs`. The json outputs are not committed (they're data).
- **Training code:** `tools/pq-train/` (`build_data.py`, `common.py`, `train.py`,
  `evaluate.py`, `run-tonight.cmd`).
- **Training environment, outside the repo:** `C:\Users\User\pq-train`
  - `.venv`: Python 3.12, torch 2.11 cu128, transformers 5.20, peft, bitsandbytes
  - `models\Qwen2.5-VL-7B-Instruct` (15.5 GB)
  - `data\` (photos at 640px plus train/test/reviewed .jsonl)
  - `runs\` (each run's log, adapter and scores.txt)
  - It runs natively on Windows; no WSL.

## How training works

- **One photo per example:** the photo, the listing title and the sheet's shot list in
  order go in; `{"shots": [...], "closeup": bool, "reflection": bool}` comes out.
- **Method:** QLoRA, 4-bit, rank 16, on the language side only (the vision tower is
  frozen). Loss is computed on the answer only.
- **The split is by listing,** using a stable hash: about 75% train, 25% test. The test
  listings never move into training. The "reviewed" set (Opus grades he passed in
  store reviews) is used only for measuring.
- **Cost:** about 10.2 GB of GPU memory at peak, about 17 seconds per optimizer step
  (8 photos per step).
- **`run-tonight.cmd`** scores the untrained baseline (skipped if `runs\baseline` already
  exists), trains for 3 epochs, then scores the trained model.
- **Before a run:** keep the laptop plugged in with the lid open. Optionally stop the
  `clueless-closet\render helper.py` (ask Ethan first). Run the keep-awake helper
  `C:\Users\User\pq-train\keep-awake.ps1`, which exits once `runs\tonight.log`
  says "overnight run finished".

## Results so far (share of shots labelled exactly right on held-out photos)

| Round | Training data | Test set | Untrained → trained |
|---|---|---|---|
| 1 (10-17) | 397 photos | 69 photos | 54% → 68% |
| 2 (10-18) | 1,759 photos | 500 photos / 73 listings | **36% → 58%** (main shot right 64%) |

- **Round 2 by sheet:**
  - Strong: cartridge games 97, video games 88, iMacs 82, iPhones 81, gaming laptops 78.
  - Weak: Windows laptops 26, Misc 34, receivers 33, item lots 12.
- **Round 2 flags:**
  - Closeup: 91% of its closeup calls were right, and it caught 74% of real closeups (97 in the test).
  - Reflection: 82% of its calls were right, and it caught 61% (23 in the test).
- **For comparison:** Opus matched Ethan's shot labels about 96% of the time on his
  confirmed set. Opus misses almost all framing problems.

**Diagnosis:** the model sees one photo at a time, so it can't tell "Side" from
"Opposite Side" or one laptop corner from another.

## Next step: round 3 (built, NOT run yet)

`86af7fc` adds "This is photo N of M in the listing… stores usually shoot in the
sheet's order" to the prompt. The train/test split is the same as round 2's, so the
result compares directly with **58%**. `runs\baseline` already exists, so tonight
skips it. Expect about 3.5 hours.

When it finishes:
- read the newest `runs\run-*\scores.txt`;
- compare it with round 2's `runs\run-20261018-0158\scores.txt`, especially Windows
  laptops, consoles and Misc.

If position helps, the bigger next idea is showing the model thumbnails of the
listing's other photos. After that: more of Ethan's labels on weak sheets, then
repeats and listing facts (multi-photo), then framing.

## Gotchas learned the hard way

- **Supabase REST silently caps a read at 1,000 rows** whatever `limit=` says. Use
  `allRows()` in picture-quality, which pages with offset.
- **Never use Supabase image transforms** (`/render/image/`); Pro allows only 100 a cycle.
  Shopify CDN `&width=` is fine.
- **`python -m http.server` let the browser cache old pages.** Use
  `scripts/serve-local.py`.
- **Ship a JS/CSS change → bump the `?v=` cache-buster in all five .html pages**
  (see CLAUDE.md).
- **The "reviewed" tier is circular for scoring Opus itself,** since those labels are
  Opus's own answers. Only the explicit tier measures Opus.
- **Identity:** "who" fields are display names from sessionStorage, not real user IDs.
