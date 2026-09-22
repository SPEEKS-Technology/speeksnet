# District Watch — build plan

Daily store-level metric tracking with statistical flagging, for the DM.

Written 2026-09-20 against live data through 2026-09-19.

**Status — Phases 1–3 are built.** Migrations `0097` and `0098` applied, the
`district-watch` edge function deployed (v3), cron job 65 scheduled and firing
on its own, 50 days backfilled, and the Watch tab built and checked. The margin
thresholds were re-tuned against the backfill before it was accepted — see
`0098` and §8.

Remaining: Phase 4 (live for a fortnight, re-tune) and Phase 5 (decide whether
managers get it). The front end is **not yet committed or merged**, so nothing
is on speeksnet.com until it ships through `pre-release`.

---

## 1. What this is, and what it is deliberately not

A fifth tab in the District Command Center on `index.html`, beside Live
Dashboard, that answers one question every morning: **which stores need me
today, and why.**

It is not a reporting page. Every number on it exists somewhere else already.
The only thing it adds is a *judgement* — that a given number is far enough
from target, for long enough, at enough volume, to be worth a conversation.

**Decisions locked (Ethan, 2026-09-20):**

| Decision | Choice |
|---|---|
| Surface | District Command Center tab, next to Live Dashboard |
| Grain | **Store level only.** No per-employee in v1 |
| Audience | Ethan first. Managers considered after a tuning period |
| Engine | New edge function + flag table |
| Small samples | Statistical significance, not a volume gate |
| Conversion target | 85% |

### Why no per-employee, even though that was the original ask

Per-employee buy margin and customer conversion **do not exist in any daily
feed.** The Day End Report has no per-employee buying or conversion breakdown —
confirmed by reading the parser in
`google-apps-scripts/sales-email-import.gs` (`_deParse`, `_deTeamProduction`).
The only per-person data that arrives nightly is Team Production: devices
processed, total cost, processed value, repriced. That is *processing*, not
*buying*.

Per-employee buying numbers exist only in `kpi_entries`, which is **weekly** and
**hand-filed by each store manager**.

Two further blockers, both found in the live data:

- **`listing_goals.result` has never been populated.** Zero on every row back to
  June 2026 — 8,000+ goals set, not one result recorded. The goal side of that
  feature works; the result side is dead.
- **Names do not join.** Matching nightly Team Production to `listing_goals` by
  name over 14 days: 173 of 216 rows match, 43 do not. MPL files weekly KPIs for
  six people and **not one** of those names appears in MPL's Team Production.
  WSP has "Jon Rodriguez" in one table and "Jonathan Rodriguez" in the other.

Per-employee tracking needs a roster/alias table first, and probably needs
`listing_goals.result` repaired. Both are their own projects. See §9.

---

## 2. Where it lives

`index.html`, the District Command Center widget (`#dcWidget`, around line 1099),
already gated `role-district-manager role-ceo` via `widget-district-command`.
That gating is why "Ethan first, managers later" costs nothing: the whole widget
is already invisible to store roles.

Adding a tab is a well-worn path in this codebase — four already exist:

1. A `<button id="dc-tab-watch">` in the `.ew-seg` strip at `index.html:1113`,
   beside `dc-tab-live`.
2. A `<div class="cc-panel" id="dc-panel-watch">` beside the others
   (`index.html:1145`+).
3. `'watch'` added to `DC_TABS` (`speeks.js:48414`).
4. A `FEATURE_CATALOG` entry `widget-district-watch` (`speeks.js:39033`-ish,
   beside `widget-district-live`), plus the search-index line at
   `speeks.js:40163`-ish and a `w-dwatch` entry near `speeks.js:40219`.

`_tabSwitch` (`speeks.js:11665`) needs no change.

> **Trap, documented at `speeks.js:11681`:** panels are stacked in one grid cell
> and toggled by *opacity, not display*, so **every tab reserves the height of
> the tallest one.** A tall Watch panel makes the whole card tall on every other
> tab. Keep it to roughly the height of the Live panel, and put depth behind a
> row click rather than on the surface.

---

## 3. What it reads

Everything comes from `day_end_facts`, which is complete: 43 of 43 days for all
five stores, every relevant column non-null.

| Metric | Columns | Target |
|---|---|---|
| Customer conversion | `cust_conv_num`, `cust_conv_den` | 85% |
| Buy margin | `est_value`, `total_spent` | 54.5% (`bm_config.target_margin`) |
| Listing / processed | `devices_processed`, `processed_value` | store goal from `listing_goals.goal` |
| Context only | `devices_lost`, `no_deal_customers` | — |

Two notes for whoever writes the function:

- **`est_margin_pct` is stored as a fraction** (0.52 = 52%), unlike most
  percentage columns in this schema.
- **`failed_deals` and `no_deal_customers` are byte-identical** at every store
  for all 43 days. Same number stored twice. Use one, and only one.

### Margin must be dollar-weighted

Never average daily margin percentages. `0004_buying_margin.sql` already says
this and it still matters: sum value and cost across the window, then divide.
Over 14 days the naive average and the weighted figure differ by 1.1 points at
OVL — enough to move it across a threshold.

---

## 4. The flag engine

Three tests. A store's state is the worst result across its metrics.

### 4.1 Does a day count as "under"? — the significance gate

This is the part that makes the whole thing work, and it is the answer to
"4 of 5 customers is not a bad day."

For conversion, a day is a binomial sample: `n` customers, `k` converted,
against p = 0.85. Compute the one-sided p-value:

```
P(X <= k | n, p=0.85) = sum(i=0..k) C(n,i) * 0.85^i * 0.15^(n-i)
```

A day counts as "under target" only when **p < 0.10**. So 4/5 (p = 0.53) does
not count. 14/20 (p = 0.09) does.

Measured against 43 days of real data, this is the difference between a useful
signal and wallpaper:

| Store | Days literally under 85% | Days that count (p < 0.10) |
|---|---|---|
| LEE | 9 | 1 |
| MPL | 18 | **1** |
| BAL | 20 | 4 |
| WSP | 25 | 6 |
| OVL | 28 | 8 |

MPL is the proof. Eighteen of forty-three days technically under target; one of
them real. Every one of MPL's other misses is the 4-out-of-5 case.

### 4.2 Acute test — the store was fine and is slipping

Yellow when **2 counting days in a row, or 2 of the last 3**.

Over the last 60 days this fires 6 times across all five stores — BAL 1, WSP 2,
OVL 3, LEE and MPL none. Roughly one event per ten days district-wide.

### 4.3 Chronic test — the store is quietly bad and never spikes

The acute test alone is structurally blind to a store that runs 81% every single
day and never has a dramatic one. OVL is exactly that store, and trips only 3
acute yellows in 60 days despite being the district's worst.

So: pool the last 14 days and run the same binomial test on the pooled
`k`/`n`. Below target with p < 0.10 → **flagged, every day, until the pooled
figure recovers.** This is the "below threshold flags every time until they get
back above" half of the rule.

Current state under this test:

| Store | Pooled 14d | p | Customers short of 85% |
|---|---|---|---|
| WSP | 80.0% | 0.074 | 7 |
| MPL | 80.4% | 0.061 | 8 |
| OVL | 83.3% | 0.280 | 3 — recovering |
| LEE | 85.0% | 0.536 | 0 |
| BAL | 85.7% | 0.623 | on target |

### 4.4 Red — the month is no longer recoverable

Yellow becomes red when the month-to-date shortfall can no longer be closed:
compute the conversion rate required across the remaining open days to land the
month at 85%, and go red when that required rate exceeds what the store has ever
sustained over a fortnight.

This is the "damage to the overall conversion for the month" condition, made
computable. It also self-clears on the 1st, which is correct — a new month is a
genuinely new chance.

### 4.5 Margin has no binomial test — it uses dollars

Margin is a dollar ratio, not a proportion of successes, so §4.1 does not apply.
The equivalent of "customers short" is **gross profit short**:

```
gp_short = (target_margin * sum(est_value)) - (sum(est_value) - sum(total_spent))
```

Rank by that, not by percentage points, because percentage points ignore volume.
Last 14 days:

| Store | Buy value | Margin | GP short |
|---|---|---|---|
| OVL | $91,557 | 50.2% | **−$3,936** |
| LEE | $40,198 | 52.5% | −$819 |
| WSP | $36,740 | 53.7% | −$283 |
| BAL | $32,206 | 55.1% | +$189 |
| MPL | $50,770 | 56.4% | +$967 |

LEE and OVL both read as "a couple of points under." In money OVL is nearly five
times the problem, because it buys more than twice the volume. On a run rate
that gap is around $100k of gross profit a year. A percentage-point threshold
would have ranked them as roughly equal offenders.

Thresholds to set in config, not code: a dollar floor below which nothing flags
(a $60 shortfall on a slow fortnight is noise), and a larger floor for red.

#### Superseded by 0100 — margin now runs conversion's whole shape

Ethan, 2026-09-21, after a fortnight of looking at the board: *"For margin,
same concept as conversion just with a 53% threshold."* The dollar floor above
stays, but only as the **chronic** test. Margin now runs all four:

| Test | Margin's version |
|---|---|
| per-day gate (§4.1) | the day is under target AND at least `gp_day_min` of GP behind |
| acute (§4.2) | 2 of the last 3 **buying** days count |
| chronic (§4.3) | the pooled window is under target and ≥ `gp_short_min` behind |
| red (§4.4) | the month can no longer reach target |

The per-day gate is the part that cannot be ported literally — margin is not a
count of successes, so there is no distribution to test against. It asks the
money question instead, and the floor was measured over the 43 buying days to
2026-09-21:

| Floor | OVL | LEE | WSP | MPL | BAL | |
|---|---|---|---|---|---|---|
| $100 | 19 | 12 | 9 | 0 | 1 | 44% of OVL's days — too chatty under a 2-of-3 test |
| **$150** | **12** | **8** | **7** | **0** | **1** | the three stores with a real problem, a quarter of their days |
| $250 | 8 | 3 | 2 | 0 | 0 | loses most of LEE and WSP |

`margin_recover_max` is margin's version of conversion's 95% line, and it had
to be measured rather than assumed. Best rolling 10-open-day dollar-weighted
margin in twelve months: **BAL 60.0, MPL 58.5, OVL 55.3, WSP 55.2, LEE 54.1**.
60.0% is the district record, so a store asked to beat it every remaining day
has lost the month.

`gp_short_red` is **retired**, not dropped — the month-lost test is margin's
only red, as it is conversion's.

#### Also superseded by 0100 — listing is judged by the week

Ethan, same message: *"for listing per week, warning needs to be if they are
behind on goal and it switches to critical if they realistically based on our
set daily goals can't catch up by end of day saturday."*

The frame moves off the rolling 14-day window and onto the **working week,
Monday to Saturday** (Sunday is closed; `openDaysBetween` already knew). A
rolling window straddles two weeks, and "240 devices short over eleven days" is
not something a manager can act on on a Wednesday.

- **warning** — more than `listing_short_min` (25) devices behind, week to date
- **critical** — the shortfall is bigger than the days still to come can absorb:
  a store is credited with `listing_catchup_mult − 1` above goal on the goal
  still to come, and no more

1.30 was measured over **runs** of days, which is what catching up actually
asks for. Over 196 three-day runs, processed ÷ goal came out at 0.84 median,
1.15 at p75, 1.48 at p90. A single day reaches 1.89 at p90 and 5.11 at its max
— which is why the single-day figure was the wrong one to reach for. One big
day is not a week of recovery.

**A closed week is graded, not escalated.** Once Saturday has gone nothing can
absorb a shortfall, so "they cannot catch up" is trivially true of every miss —
and judged that way, 28 of the first 73 reds were Saturdays and Sundays. A
finished week is measured on the same yardstick applied to the whole week: MPL
closing 36 behind on a goal of 154 is a warning; OVL closing 85 behind on 190
is not.

`listing_short_red` is retired for the same reason `gp_short_red` is, and a
fixed 200-device red inside a 170-device week could never have fired anyway.

What the re-backfill produced over the six weeks to 2026-09-20, out of 200
store-days per metric:

| Metric | critical | warn | ok |
|---|---|---|---|
| conversion | 16 | 51 | 133 |
| margin | 3 | 42 | 155 |
| listing | 65 | 16 | 119 |

Margin's three reds are all OVL, late August, and they are real — that is the
month it lost. Listing's 65 look alarming until you see where they sit: MPL 24
and OVL 23, against BAL 1. Those two stores miss their staffed listing goal by
30–50% most weeks, which the weekly tables bear out. The engine is not crying
wolf; listing is the district's worst metric.

### 4.5b Drifting — the fourth thing a metric can be saying (0101)

Ethan, 2026-09-21, looking at the board: *"I would like to know at a glance why
someone is in a warning or critical, or if they are good and have a negative
trend starting."* The last clause is a state the three colours could not
express — a store was clear or it was flagged, with nothing in between.

`drifting` is that in-between, and it is deliberately **not** a fourth state.
It never changes a store's colour and never puts it on the triage list; it only
annotates a metric already reading ok. Two arms:

| Arm | Fires when |
|---|---|
| a bad day | the metric is **under target** for the window AND at least one day in the acute window counted |
| a trend | the window's second half is worse than its first by more than the drop below |

**The guard on the first arm is the whole point.** Without it, a store sitting
above target with one wobbly day in the window reads as sliding — which is
exactly the noise this engine exists to avoid, and contradicts the rule Ethan
set on day one ("missing one person isn't bad"). BAL's margin, 55.1% with one
$164 day, was flagged as drifting by the first cut and is not now.

**The trend arm has no such guard**, because *good and getting worse* is
precisely the case that was asked for.

The drops were measured, after a first cut at 2 points and 1 point turned out
to sit near the MEDIAN of ordinary variation and marked three of five stores as
drifting on a normal day. Older half minus newer half, over 120 days:

| | p50 | p75 | p85 | **p90** |
|---|---|---|---|---|
| conversion | 0.41 | 4.49 | 7.32 | **8.99** |
| margin | 0.17 | 1.49 | 1.98 | **2.59** |

At the 90th percentile — 9.0 and 2.5 — the annotation lands on 12% of clear
conversion days and 17% of clear margin days. Listing's is simpler: behind the
weekly goal but by less than `listing_short_min`, which is 37% of its clear
days and is just a fact about how often the rota is missed narrowly.

These two live in the edge function, not in `watch_config`, unlike every
threshold that can flag a store. Drift only annotates; a wrong value costs a
word on the board rather than a store's colour.

### 4.5c What the board says, and where it says it (0101)

The row used to carry the engine's full sentence, three times per store. That
is a paragraph per store and fifteen sentences a page — something to read
rather than something to scan. The sentence moved to the row's `title`. Each
metric is now its own table row — label and figure under **Store**, a plain
phrase under **Status**, so the phrase sits centred under the store's tag by
construction rather than by a width kept in step:

```
MARGIN      50.2%     Under target and slipping    13d
LISTING     55% of goal   Can’t catch up this week  5d
CONVERSION  83.3%     Slightly under target
```

Revised the same evening after Ethan's review: the figure is always the
metric's own percentage ("for margin it should be % based like the threshold
not $ behind" — dollars stay in the hover), and the phrase names the state in
plain words, never the test ("I don't understand the fortnight stuff"):

| Fired | Phrase |
|---|---|
| month_lost | Month is out of reach / Can’t catch up this week |
| acute + chronic | Under target and slipping |
| acute | Slipping |
| chronic | Under target / Behind for the week |
| drifting, under target | Slightly under target / Slightly behind |
| drifting, above target | Slipping, still on target |
| ok | On target / Week cleared |

**The words are chosen in `speeks.js`, not in the engine.** 0101 stores WHICH
test fired as four booleans (`acute`, `chronic`, `month_lost`, `drifting`)
rather than as a second, shorter sentence. A pre-written headline column would
mean the same judgement worded in two places that can drift apart, and every
re-wording would cost a redeploy plus a 47-day re-backfill. As booleans,
re-wording the board is a JS edit and a cache-buster bump.

**The day count is days in a row finished under target, not the flag
streak.** It first printed `watch_flags.streak` (days in the same state), and
"Under target · 13 days" on OVL margin read as thirteen bad days running when
only the last three were. Ethan (2026-09-21) wanted the literal count, because
the board is for deciding who to talk to today. The front end counts it from
the 21-day series the board already receives (`_dcwMissRun`): open days only
(closed days, and listing days with no goal, are stepped over), literal (no
volume test), and "12+" when the run reaches the start of the series. It reads
"Missed N days in a row", "Missed yesterday", or "Hit target yesterday" ("yesterday" means the last open day, so Saturday on a Monday), and it
appears only on flagged or drifting lines. The flag streak is still in the
hover sentence.

### 4.6 The guardrail worth keeping

`speeks.js:42357` already carries this for the weekly buyer report and it
applies just as well per store: **margin rising while conversion falls** means
margin was bought by walking deals. Surface it as a note, never as a flag —
it is a different conversation.

---

## 5. Schema

Two tables. First built at **0097**, re-tuned by 0098 (margin floors), 0099
(53% target, listing added), 0100 (margin gets conversion's shape, listing
moves onto the week) and 0101 (which test fired, and drift). Next migration
number is **0102** — but confirm with
`ls supabase/migrations | sort | tail -1` first; that line goes stale, and
migration numbers in this repo are already duplicated in two ranges.

### `watch_config` — one row, id = 1

Everything tunable lives here, so tuning never needs a deploy. Mirrors the
`bm_config` pattern.

```
conv_target        numeric   default 85.0
margin_target      numeric   default 54.5
p_threshold        numeric   default 0.10     -- significance gate
acute_window       int       default 3        -- "2 of last 3"
acute_needed       int       default 2
chronic_window     int       default 14
gp_short_min       numeric   default 1250     -- dollars, below this margin never flags
gp_short_red       numeric   default 3000
```

(Both dollar floors shipped at 250 / 2000 and were raised by `0098` after the
backfill proved them too low — see Phase 2b.)

### `watch_flags` — one row per store, per metric, per day

Append-only. This is the flag history, which is what makes "OVL was flagged on
margin 11 times this quarter" a query rather than a memory.

```
day, store, metric                  -- primary key
state                               -- 'ok' | 'warn' | 'critical'
value, target                       -- what it was, what it should be
sample_n, sample_k                  -- the volume behind it
p_value                             -- null for margin
shortfall                           -- customers, or dollars
streak                              -- consecutive days in this state
reason                              -- the English sentence shown on screen
```

`reason` is generated server-side and stored. It is worth the column: the
sentence is the product, and computing it in the browser would mean the email
(if it ever ships) and the board could word the same flag differently.

---

## 6. Edge function and cron

`supabase/functions/district-watch/`.

Runs once per store per day, computes all three tests, upserts `watch_flags`.
Idempotent on (day, store, metric), so a re-run repairs rather than duplicates.

**Cron slot.** The morning chain is: `day-end-ingest` hourly at :05 (guarded),
`processed-report` 6:15 Central, `daily-brief` 7:15 Central. District Watch
needs `day_end_facts` complete, so **6:25 Central**, between them.

Follow the established double-job pattern — a `-cdt` and a `-cst` job with an
internal guard, exactly as `processed-report-810am-cdt` / `-cst` do — rather
than one job that drifts an hour twice a year.

The binomial CDF needs a factorial helper. In Deno that is a dozen lines and
should be written in TypeScript, not SQL. (I wrote the SQL version to validate
the thresholds above; it needs a factorial CTE and is genuinely unpleasant.
Keep it out of the migration.)

---

## 7. Front end

One renderer, `renderDistrictWatch()`, in the district board area of
`speeks.js`. Reads `watch_flags` for the latest day plus 12 days of
`day_end_facts` for sparklines.

The comp is artboard A here: https://claude.ai/artifact/EnZudUHj6WALP4npQD8AMN

Surface layout, subject to the height constraint in §2:

- Four summary tiles: stores needing attention, district MTD conversion,
  customers short this month, devices lost.
- One row per store: code, status chip, conversion with a 12-day sparkline
  against the 85% line, margin against target, listing vs goal, shortfall, and
  the `reason` sentence.
- Row click drills to that store via `_dcDrill()`, which already exists.

Reuse `_dcSev()` (`speeks.js:48454`) for severity classes so a metric that is
red here is red on the other district tabs. Reuse `_dcStoreCell` and
`_dcRowOpen` for the rows.

**Ship checklist:** bump the cache-buster in all five HTML pages — `index.html`,
`operations.html`, `workspace.html`, `stats.html`, `docs.html`. A JS change
without it means users keep the old file.

---

## 8. Build sequence

Each phase is shippable and verifiable on its own.

**Phase 1 — engine, no UI. DONE.** Migration 0097 (both tables), the
`district-watch` function, cron job `district-watch-625am` (jobid 65, `25 * * * *`
with a Central-hour guard of 6) and its `cron_expectations` row. Verified by
reading `watch_flags` back and confirming it reproduces §4 exactly.

**Phase 2 — backfill. DONE.** All 50 days (2026-08-01 → 09-19), run forward in
two chunks so streaks build correctly, zero failures.

**Phase 2b — the first tuning, which Phase 4 was supposed to do. DONE, EARLY.**
The backfill immediately showed the margin floors were wrong: at `gp_short_min`
= $250, LEE warned 45 days running and WSP 37 — three permanent ambers, the
exact wallpaper failure this project exists to avoid. Raised to $1,250 / $3,000
in `0098` against measured evidence, and the history recomputed. Result:

| | before | after |
|---|---|---|
| LEE margin warns | 45 / 50 | 15 / 50 |
| WSP margin warns | 37 / 50 | 1 / 50 |
| OVL margin critical | 21 / 50 | 12 / 50 |
| flags on a typical day | 5–8 | 3 |

Worth recording that the *conversion* side needed no tuning at all — it was
fitted to real data before it was written, and the margin side was not. That is
the whole argument for validating a threshold against history before shipping it.

**Phase 3 — the tab. DONE.** `dc-tab-watch` + `dc-panel-watch` in `index.html`
(second, right after Live), `'watch'` in `DC_TABS`, the `widget-district-watch`
feature key with its search-index and palette entries, `DISTRICT_WATCH_URL`,
`fetchDistrictWatch()` / `renderDistrictWatch()` / `_dcWatchHtml()` in the
district module of `speeks.js`, a CSS block beside the other `dc-tbl` rules, and
the cache-buster bumped to `20260921b` on all five pages.

**Phase 3c — margin target 53%, and listing becomes a flagged metric.**
Migration `0099`, both asked for on 2026-09-21 after a day on the board.

Lowering the margin target meant **rescaling the dollar floors**, which is the
non-obvious half. Every shortfall drops by 1.5% of buy value when the target
moves 1.5 points — about $1,374 a fortnight at OVL — so at the old
$1,250/$3,000 floors OVL's *worst* fortnight in six weeks ($2,581 behind) could
never have reached red. The floors are a distance **from** the target, not
independent of it. Rescaled to $750 / $1,750, which restores the behaviour
`0098` tuned for.

Listing is judged on **devices short of the staffed goal** — `listing_goals`
summed across the roster, pooled over 14 days — with floors at 60 (warn) and
200 (critical) devices, and a 60-device minimum goal so a barely-filled rota
cannot flag. Measured over 32 rolling windows, 25 was far too low (every store
tripped it a third of the time, including the three that clear their goal on
average); 60/200 leaves OVL the standing problem, MPL clearly behind, and the
rest occasional.

**Phase 3b — the store popup.** Clicking a Watch row opens `#dcWatchModal`
rather than jumping to Store Breakdown, which is what it did first and what
every other district table still does. The Watch tab is a triage list read
top-down; swapping the tab underneath loses your place in it (Ethan,
2026-09-21). Three tabs — Customer Conversion, Buying Margin, Listing
Productivity — each a summary row over the last **7 open days** (not 7 calendar
days: Sunday is closed everywhere, and a blank row reads like a zero).

It renders from the payload the board already holds, so there is no second
fetch and no chance of the popup disagreeing with the row behind it. The
`board` action grew `devices_processed` / `processed_value` on the series and a
`goals` array summed per store per day.

**Listing Productivity is shown, never flagged**, and the tab says so. The two
listing feeds disagree by 15–30% (`0095`) and a store-day goal is the roster's
total, so a day with most of the team off carries a goal of 2. Useful as
context beside the other two; not a score. `watch_flags` still emits no
`listing` rows.

Four check suites, 80 assertions, all passing:

| File | What it covers | Run with |
|---|---|---|
| `district-watch-check.js` | wiring, sort order, the shortfall reaching the screen, escaping | (no flag) |
| `district-watch-popup-check.js` | the drill-down — the 7-day window, dollar-weighting, zero-goal safety | (no flag) |
| `district-watch-layout-check.js` | measured at 390 / 820 / 1440 — overflow, sparkline size, wrapping, panel height | (no flag) |
| `district-watch-dom-check.js` | the real `index.html` — ids, role classes, `data-feature`, the popup shell | `-Html index.html` |

The popup suite's load-bearing assertion is the dollar-weighting one. Its
fixture is built so an average of the seven daily margin percentages (63.7%)
and the dollar-weighted figure (30.3%) cannot coincide — a 33-point gap, in the
flattering direction, that nothing on screen would otherwise reveal.

The DOM suite exists because the other two build their own markup, which only
proves the copy agrees with itself. It is the one that would catch the tab being
moved out of its container and losing its role gate.

The layout suite carries a **panel-height tripwire at 620px**. Every `dc` panel
shares one grid cell and is toggled by opacity, so the card reserves the height
of the tallest tab — a long Watch panel makes Live tall too. If that assertion
ever fires, move depth behind the row click rather than raising the number.

**Phase 4 — tune.** Live with it for a fortnight. Expect to move
`p_threshold` and `gp_short_min`. That is what `watch_config` is for.

**Phase 5 — decide on managers.** Only after tuning, and as its own decision.

---

## 9. Open, deliberately deferred

- **Roster / identity.** Prerequisite for anything per-employee. Needs a table
  of people with store, role, active dates and name aliases. Until it exists,
  attribution anywhere in this app is a free-text display name out of
  `sessionStorage` (`_b2bUser()`, `speeks.js:15783`) and is spoofable.
- **`listing_goals.result`.** Why was it never written? Until that is answered,
  goal-vs-actual has to come from a name join against Team Production.
- **The email.** Option B in the comp. Cheap once the engine exists — it is one
  more reader of `watch_flags`. Deferred, not rejected.
- **Whether `failed_deals` should be dropped.** It duplicates
  `no_deal_customers` exactly.

---

## 10. The main risk

The thresholds are right on today's data and will drift. The honest failure mode
is not a missed flag — it is a board with three permanent reds that stops being
read. Everything tunable therefore lives in `watch_config`, and Phase 4 exists
because the first set of numbers will be wrong somewhere.

The second risk is scope. This plan is store-level because store-level data is
complete and clean. Every request to add "just one" per-employee column should
be answered with §1.
