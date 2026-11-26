# Listing Review Flow — design for Ethan's OK

Status: **DESIGN ONLY, 2026-11-18.** No code, no migration, and no paid call
until you say yes. The questions at the end need your answer first.

## What it is for

You stop reviewing every listing yourself. The checks flag problems. Managers
fix them from **one queue**. Each day you spot-check the **10 highest-price
listings per store that the checks passed**. When you disagree, the listing goes
back to the store, it counts against the lister, it counts as a miss for the
checker, and it becomes a note you copy to Claude to fix the rules.

```
 new listing ──► nightly checks ──► FAIL ─► Store Fix Queue ─► Mark Fixed ─► re-grade ─┬► fails  ─► back to store
                    (photos, title,                                                     └► passes ─► Ethan: Confirm Fixes
                     label, category)                                                                (Confirm / Send Back)
                       │
                       └─► PASS ─► top 10 by price per store ─► Ethan: Daily Spot Check
                                                                 Agree │ Grade It Myself ─► back to store
                                                                                          + lister flag
                                                                                          + checker miss
                                                                                          + Listing Health Note
```

---

## Screen 1 — Store Fix Queue (managers)

Listing Health → **Fix Queue**, for the manager's own store. For managers it
replaces the Title Quality / Picture Quality / Categories tabs. No Photos stays
in it as a red card at the top, as it is now.

**One card per listing.** Everything wrong with the listing is on the card:

```
┌───────────────────────────────────────────────────────────────┐
│ Dell Latitude 5420 i5-1145G7 16GB 256GB      $389   [Jordan] │
│ LEE-04412 · listed Nov 17 · Open In Shopify ↗                 │
│ ⟲ SENT BACK BY ETHAN: "Photo 3 is the back, no port shot."    │ ← only on returned cards
│                                                               │
│ PHOTOS   ✗ Missing: Ports Left, Ports Right                   │
│          ✗ Order: the label is photo 2, should be last        │
│                                          [Approve Order] [Dismiss] │
│ TITLE    ✗ Says i5-1135G7 — the label in photo 9 says 1145G7  │
│          Suggested: Dell Latitude 5420 i5-1145G7 16GB 256GB…  │
│                                          [Approve Fix]   [Dismiss] │
│ CATEGORY ✗ On "Other" — belongs on Laptops [Approve Fix] [Dismiss] │
│                                                               │
│                                                  [Mark Fixed] │
└───────────────────────────────────────────────────────────────┘
```

- **Sources, read live** (no copies): photos = open `picture_quality_reviews`
  rows; title = open `listing_title_reviews` rows; **label** = title rows whose
  finding came from the label check (shown as a title line with the photo); 
  category = the `shopify-recat` queue (Other pile, misfiled, unmatched).
- **Approve Order / Approve Fix** call the existing one-click actions
  (picture-quality `reorder`, listing-titles approve, shopify-recat `apply`).
  The tool did the change, so those lines are done at once with no re-grade.
- **Dismiss** is per line and needs a reason. It goes through each tool's
  existing dismiss, so the reason lands in Listing Health Notes as now.
- **Mark Fixed** is for the lines only a person can fix (a missing shot, a
  retake). Like Resolve on Claims & Disputes: the card moves to a *Marked
  Fixed — Rechecked Tonight* drawer and waits for the overnight Batch
  re-grade. Never re-graded on the spot. Shown only while such a line is open.
- **Order:** sent-back cards first (yours, then failed re-grades), then newest
  listing first. The card vanishes when nothing on it is open.
- Count on the Listing Health pill and the All Stores card = cards, not lines.

## Screen 2 — Daily Spot Check (you)

Listing Health → **Spot Check**, one section per store, picked once a day at
6am CT so the list does not move under you.

**Who gets picked:** listings first live on the online store yesterday (Monday
covers Fri–Sun), live now, whose photo check PASSED, with no open title
(Wrong / Hard To Find) or category line. The **10 highest Shopify price** per
store. Fewer than 10 passes = fewer cards; nothing fills in from older days.

Each card: the photos in order, title, price, lister, the sheet's required
shots. Two buttons:

- **Agree** — nothing happens to the listing. It is recorded, so you never see
  it again and the checker gets credit for a right pass.
- **Grade It Myself** — opens a form:
  - ticks for each required guide shot that is **missing** (from the sheet);
  - **Wrong Order**;
  - **Title Wrong** / **Field Wrong** (which field) / **Category Wrong**;
  - a **note** (required).

  Saving it does four things:
  1. **Sends it back** to the store's Fix Queue as a card headed *Sent Back By
     Ethan* with your ticks as lines and your note — the title-notes
     `send-back` pattern (0156: `returned_note/by/at`).
  2. **Counts against the lister's flag rate** (lister = the Shopify tag,
     through the same `listerFrom` matcher Picture Quality uses).
  3. **Records a miss against the checker** — which check passed it wrongly
     (photos, title, category).
  4. **Writes a Listing Health Note** through picture-quality `should-flag`
     (kind `should_flag`), so it shows under *Open Listing Health Notes … copy
     the ask for Claude* with your ticks spelled out.

## Screen 3 — Confirm Fixes (you), separate from the daily 10

Its own section under Spot Check, labelled **Confirm Fixes — re-graded and
passed**, never mixed into the 10. A card shows what was wrong, the new photos
/ title, and who marked it fixed.

- **Confirm** → done.
- **Send Back** (note required) → back to the store, headed *Fix Not
  Accepted*. Does **not** count against the lister a second time (it is still
  the same flag).

## Screen 4 — Lister Flag Rate (you)

Listing Health → **Flag Rates**. One table per week (Mon–Sun CT), last 8 weeks,
a store picker:

| Lister | Listed | Checker flags | Your send-backs | Flag rate |
|---|---|---|---|---|
| Jordan | 41 | 9 | 2 | 27% |

- **Listed** = listings the nightly check graded that week for that lister.
- A listing counts **once** however many lines it had. A flag where every line
  was dismissed by the manager is shown, greyed, but not counted.
- **Unknown** row for listings with no matching tag, as everywhere else.
- Under the table, one line per checker: *Photos: 3 misses in 50 spot checks*.

---

## Data — migration **0189** (max applied is 0188; no open branch has 0187+)

1. **`listing_review_cards`** — one row per listing with a card's history.
   `store_code, product_id, sku, title, price, lister_tag, status`
   (`open` → `fixed` → `regrading` → `confirm` → `done`; or back to `open`),
   `round` (times it came back), `returned_kind` (`spot`, `regrade`, `confirm`),
   `returned_note/by/at`, `fixed_by/at`, `regrade jsonb` (what the re-grade
   said), `confirmed_by/at`, `opened_at`. The card's *lines* are not copied —
   they are read from the source tables; the card is the envelope that carries
   status, rounds and notes.
2. **`listing_spot_checks`** — `day, store_code, product_id, sku, price,
   lister_tag, rank, result` (`pending|agree|graded`), `ticks jsonb, note, by,
   at, checker_passed jsonb` (which checks had passed it). Unique on
   (day, store_code, product_id). The 6am pick inserts the 10 `pending` rows.
3. **`listing_flags`** — the ledger the weekly view sums: `week, store_code,
   lister_tag, product_id, source` (`photos|title|label|category|ethan`),
   `checker_miss bool, dismissed bool, at`. Unique per (week, product_id,
   source) so re-runs never double count.
4. **`picture_quality_reviews`**: add `lister_tag`, `price`,
   `first_live_at` — so the pick and the *Listed* count need no Shopify read.
5. pg_cron: 6:00am CT spot-check pick (free); the re-grade submit after the
   nightly grade; the existing poll collects it.
6. RLS on, no policy (the house pattern); `ai_reader_refresh_grants()` after.

## Edge functions

- **New `listing-review`** (PIN auth, same `scopeFor` posture):
  `?view=queue&store=` (cards with lines, merged from the three sources),
  `?view=spot&store=&day=`, `?view=confirm`, `?view=flags&weeks=8`;
  POST `mark-fixed`, `spot-agree`, `spot-grade`, `confirm`, `send-back`;
  secret path `?pick=1` (6am) and `?regrade=1` (overnight).
- **picture-quality**: save `lister_tag`, `price`, `first_live_at` when it
  grades; `runReviews` accepts a list of product ids from `listing-review` for
  the re-grade (the Batch path already exists, `pq_batches`); when the poll
  lands a re-grade, it tells `listing-review` the verdict.
- **listing-titles / shopify-recat**: no change. Their re-check is the
  existing free rule sweep (titles' paid name pass already runs nightly and is
  already paid for).
- **Front end**: a new Fix Queue renderer for managers (reuses `_ltWhy`,
  `_ltListerPill`, the `_ltAsk` dialog); Spot Check / Confirm Fixes / Flag
  Rates for the DM. Feature keys `ec-view-fix-queue` (manager, owner-manager,
  ASM) and `ec-view-spot-check` (DM, CEO). Cache-buster bump on all seven
  pages.

## What it costs — needs your yes before anything runs

| Paid call | How many | Cost / month |
|---|---|---|
| Nightly guide-only photo grade of every new listing (Batch, ~5c) — **needed**: the spot check's "passed" list and the flag-rate *Listed* count come from it. Nightly is paused now. | ~49/day | **~$74** |
| Re-grade of **Mark Fixed** cards, photo part only, overnight Batch (~5c). Estimate: 40–60% of new listings get a photo line (LEE 10/10, WSP 4/10 on 11-18). | ~600–900 | **~$30–45** |
| Re-grades of your send-backs | ~5/day | ~$8 |
| Title / category re-checks | free rules | $0 |
| **Total new** | | **~$110–125** |

Run direct instead of Batch, the re-grade alone would be ~$140–210. Batch
means a fix marked today shows its result the next morning. Nothing above
runs until you say so; the build and local test use no paid call (re-grade is
faked in the checks).

## Going live

Picture Quality is **parked** on the live site. The Fix Queue shows photo
lines to managers, so shipping it means un-parking the photo check for
managers. Built and tested locally on 8080 only; the un-parked
`ec-view-picture-quality` line in the working copy stays out of any commit.

---

## Decided (Ethan, 2026-11-18)

- **Managers and ASMs** see and work the Fix Queue.
- **Re-grade is overnight Batch only, never immediate.** Mark Fixed works like
  Resolve on Claims & Disputes: the card leaves the store's open list as
  *Marked Fixed — Rechecked Tonight* and is re-graded in the overnight run.
- Screens will be adjusted after Ethan sees them rendered.

## The title numbers, corrected

The ~370 / ~260 in the first draft were wrong. They counted every `open` row in
`listing_title_reviews`, not what the tool shows. The title check *did* find
these; most of them are just not shown:

| | Wrong | Hard To Find | Opportunity |
|---|---|---|---|
| Open rows in the table | 138 | 115 | 259 |
| Listing gone / sold (never shown, harmless) | 90 | 81 | 214 |
| Live on Shopify, same title, **not live on eBay** — hidden | 43 | 33 | 42 |
| **Shown in Title Quality today** | **4** | **1** | **3** |

The hidden 118 are your rule from 2026-08-28 (migration 0070): the title queue
shows only listings that are in stock, on the online store **and live on eBay**
— "make sure everything customer facing is being fixed". About 62% of live
Shopify listings are not on eBay, and the eBay-live ones get worked off because
they are shown, so the hidden pile is where the open findings collect.

## Decided, round 2 (Ethan, 2026-11-18)

- **Titles: a listing shows if it is in stock and live on EITHER channel** —
  the online store OR eBay. Ethan: "This should have always been both online
  store and eBay live listings." Migration 0189 redefines `listing_title_queue`
  to that rule, so the old Title Quality tab and the Fix Queue agree (126 today
  instead of 8). 0070's eBay-freshness guard goes with it.
- **All three title tiers** go on the cards: Wrong, Hard To Find, Opportunity.
- **Costs approved in principle, both overnight Batch (~$110–125/mo), but
  Ethan confirms before either starts.** The build ships with the nightly grade
  still paused and the re-grade job switched off. Local tests fake the
  re-grade, so they make no paid calls.

---

## Built (2026-11-18) — where things differ from the design above

- **Live now:** migration 0189 (tables, the either-channel title view, three
  free crons), `listing-review` deployed, `picture-quality` and `shopify-recat`
  deployed with Fix Queue holders allowed to take their actions. Front end is
  local only (speeks.js / styles.css / operations.html, cache-buster
  20261118q), uncommitted.
- **Paid runs still off.** The nightly photo grade is still the 10-random
  sample (`PQ_NIGHTLY_PAUSED` / `NIGHTLY` in picture-quality), and the
  re-grade returns "paused" until `LR_REGRADE_ON=1` is set. Both wait for
  Ethan's go.
- **Spot-check pick:** any photo PASS graded in the last 7 days that has not
  been spot-checked, not only "listed yesterday", because the nightly grade
  currently covers only a sample. Narrow it once every new listing is graded.
- **Label catches show as Title lines.** The title tool does not save which
  name findings came from the label check, so the card cannot tell them
  apart. The `label` kind is wired and lights up if listing-titles starts
  marking those findings `source: "label"`.
- **Category Dismiss** is shopify-recat's skip with the reason. Skips are not
  part of Listing Health Notes today, so those reasons stay in the Categories
  tool's Skipped drawer and don't reach the copy-for-Claude ask.
- **Flag rates are high** (40–100% on 11-16) because every title finding,
  Opportunity included, counts as a flag. If that is too blunt, count only
  Wrong + Hard To Find, or photos only.
- **No Photos** is the red block at the top of the Fix Queue.

## Since the build (2026-11-18 → 19)

- **Redesigned with no tabs** (Ethan picked two drawings from the Listing
  Review Redesign canvas). Managers and ASMs get one list-and-detail queue. The
  DM gets **Today**: store tiles that open what that store sees, Spot Check
  and Confirm Fixes one listing at a time, All Listers, and two note popups.
- **Notes kept apart.** Spot Check Notes holds the DM's own send-backs (0190
  `triaged_at`, with its own feed card). Listing Health Notes holds the stores'
  "Not Wrong" reasons.
- **The spot check is PICTURES ONLY for now** (Ethan, 11-19). Send Back offers
  the guide's missing shots and Wrong Order, which the photo check looks at,
  plus Angle, Framing and Dirty Table, which only Ethan checks.
  - A send-back with only those three skips the paid recheck when the store
    fixes it, and goes straight to his Confirm Fixes as "Check By Eye".
  - Titles, categories, listing fields and the listing-details panel were
    tried for a day and removed.
  - Next: extend it to a full listing review, possibly with a small redesign.

## Loose ends before the training rounds (started 2026-11-23)

Ethan's plan: tie up the display, keep this list as the full listing review is
folded in, then run a few start-to-finish testing rounds across roles (manager,
ASM, DM) before anything goes live. Tick items off here as they close.

**Display (walking it now)**
- [x] View Listing: full description in place of the field grid; Included/Not Included only when the description lacks them; "No Photos"; arrows on the main photo (11-23).
- [ ] Full Listing Review now flags Photos / Title / Price / Included / Listing Description (the field parts are gone): check it still reads right.
- [ ] Manager list + detail: still looks right after the guide-only change (fewer finding kinds).
- [ ] DM Today, Spot Check, Confirm Fixes, All Listers: same.
- [ ] All Listers numbers after the flag clean-up (titles sev 2–3 only, no categories).
- [ ] Category lines on the card: say plainly they are not counted against the lister?
- [ ] Could Be Better titles: shown as opportunity, not as a mistake.

**Behaviour**
- [x] Full review: flagged part is one red border; Title already flagged by the Title Check cannot be flagged again (front + server); Photo Check findings shown on Photos (11-23).
- [x] Full review list = each store's top 10 by price from the day before (0202 listing_full_picks, daily 6am; unreviewed carry over as Missed). Preview for 11-23 picked; tomorrow 6am replaces it with the whole day (11-23).
- [ ] Notes Only on full review (to the manager, not counted) + a safe test path Test DM → Test Manager (test sessions block writes today).
- [ ] Send-backs: "Flag" or "Just Notes" choice. Just Notes goes to the manager, not the lister, and is not counted.
- [ ] Batched sheet pick: watch the first real run (pick round → review round).
- [ ] All-day check: turn on (PQ_TRICKLE_ON=1) only on Ethan's go; nightly stays paused.
- [ ] Overnight re-grade (LR_REGRADE_ON=1): only on Ethan's go.
- [ ] LEE accuracy review against the 85% bar (5 in Spot Check, 5 on LEE's list; the grades were redone 11-23 guide-only).

**Before merge**
- [ ] Re-park `ec-view-picture-quality` in the catalog before committing.
- [ ] Commit only this work: speeks.js holds other sessions' edits too.
- [ ] Cache-buster on all 7 pages.
