# Store Alerts Hub — plan (2026-11-20)

One work-only feed per store phone. SPEEKSNET decides what matters and pushes
it; everything else stays quiet. Pilot: Ethan's iPhone + BAL (MO04).

## Principles (from Ethan)
- Short. One line per alert, verb first: "Reply to 2 eBay buyers."
- Every push opens a **Today** page: a checklist of what to do, nothing else.
- Rules live in the database. The DM adds/changes/pauses rules in SPEEKSNET and
  it takes effect on the next run — no code change, no merge.
- iPhone first (home-screen app, iOS 16.4+), Android works from the same code.

## What already exists (reuse, don't rebuild)
| Need | Existing piece |
|---|---|
| Who gets what (store/role/person) | `notify` audience → people → prefs pipeline, `notify_sent` dedupe |
| Claims/disputes due today | `claims-disputes?action=alerts&stores=` (`dueAlerts`, `stateOf`) |
| Props / coaching signals | `daily-brief` rule engine (praise/correct, thresholds), `district-watch` flags |
| Day data | `day_end_facts`, `daily_np`, `listing_goals`, `daily_buysell` |
| Recurring dates | `store_calendar_events.repeat` (expanded only in the browser today) |

Missing: any push stack (no manifest, service worker, subscriptions, sender),
DB-editable rules, server-side recurrence, store-inbox reading.

## Build phases
1. **Push foundation** — `manifest.json`, apple-touch-icon, `sw.js`, a "Turn on
   alerts" button, `push_subscriptions` table, VAPID keys, new `alerts-hub`
   edge function that sends a push. Done = Ethan's iPhone gets a test push.
   *Needs one merge to main*, since the site is served from main.
2. **Rules + reminders** — `alert_rules` table + DM-only rule editor. Seed:
   - Inventory: Monday of week 2, then every Monday until marked Done that month.
   - Fri: check supplies, order if needed. Fri: box order check.
   - Mon: plan this week's cleaning schedule.
   Each reminder has a **Done** tap; Done stops repeats for that period.
3. **Store inbox (MO04)** — Apps Script in mo04@paymore.com posts new mail
   headers to `alerts-hub`. Rules: eBay buyer message / Shopify customer email →
   "Reply to customer: <name>". Noise is dropped. (eBay and Shopify already email
   the store inbox, so no new eBay API is needed.)
4. **Morning digest + Today page** — one push ~9:00 CT: "Today: 3 claims, 1
   reply, inventory." Today page sections: Do today (claims/disputes/returns,
   replies, reminders), Props (wins from yesterday), Coach (one or two misses).
   Rule-based text first (free, short); a Claude rewrite only if wanted, with the
   cost quoted first.
5. **Later** — Ethan's SPEEKS (Microsoft 365) inbox once Paul OKs the app
   registration; DM digest; roll out to all five stores.

Discord: not possible (PayMore owns the server). Managers turn on Discord app
notifications for the needed channels on the work phone.

## Ethan's DM email priorities (for phase 5)
1. Paul — top. 2. Any @paymore.com sender — top. 3. Store managers — next.
4. Hayden — normally "when you have time". 5. Any other real person — earliest
convenience. Newsletters/automated — never push.

## Open questions
- Pilot audience: BAL alerts to Ethan only, or also the new BAL manager's phone?
- Digest time (proposed 9:00 CT, after Day End 8:00 and claims 8:35).
- Branch: build on its own branch off pre-release so phase 1 can ship without
  waiting on the December branch.
