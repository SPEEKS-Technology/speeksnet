# Session handoff — 2026-11-08 (QuickPortal Inventory, Listings & Deals, MSM removal)

Paste this into a new Claude Code session in `C:\Users\User\Documents\GitHub\speeksnet`.
Read `CLAUDE.md` and `docs/quickportal/HANDOFF.md` (section "THE TABS PAGE") first —
both are updated for everything below.

## Where things stand

- Branch `Main-December-Update-1---Ethan`, HEAD `e110aa1`, level with origin.
- **Everything below is UNCOMMITTED** (25 modified files + new
  `supabase/migrations/0180_day_end_available_value.sql`). Nothing pushed.
  Ethan has not asked for a commit yet — ask before committing; push only on his OK.
- Cache-buster in all six pages: `?v=20261108ze`.
- Verified: 35 browser-check suites run; 29 pass, the other 6 fail identically on
  committed HEAD (pre-existing, see "Known failures").

## What was built this session (all in the working tree)

1. **Inventory tab** (`QPT_TABS` key `inventory`, `merge: 'inv'`,
   `_qptMergeInv` / `_qptRenderInv` in `speeks.js`; CSS "INVENTORY AS ONE CARD").
   - DM: **Pace Board** — a row a store, most in stock first: In Stock · Value
     (Day End Available card), processed last 7 days as bars, latest / avg (amber
     under 60%), top producer.
   - Store (manager, ASM **and employee** — same card): band = Available Devices |
     Available Value | Processed · Latest Day, then **Person Tiles** (latest,
     7-day bars, Daily Average, Total · N Days Worked, value).
   - "Days", never "reports", for Day End figures across QuickPortal widgets/minis.
2. **In-stock VALUE is stored** (Ethan: "show the value not the cost").
   - Migration **0180** applied: `day_end_facts.available_value` (= the Available
     card's Projection).
   - `day-end-ingest` (saves it, plus `?goals=0` to skip goal rewrites) and
     `store-snapshot` (sends it; **employees now get the whole team's production
     line**, Ethan-approved) — both DEPLOYED and byte-checked.
   - `google-apps-scripts/sales-email-import.gs`: 3 lines send `availableValue`.
     Ethan pasted it and **published a new version**. Nov 6–7 re-read; values live.
   - Ran `ai_reader_refresh_grants()` so the Claude connector can read
     day_end_facts again (a new column locks it out until refreshed).
3. **Listings & Deals tab** replaces Company & Tools (design B of artifact
   9jz7JGawrggijNciHztmKu). Key `deals`, `merge: 'work'`, `_qptMergeWork` /
   `_qptRenderWork`: B2B, Variance, SPEEKS Connect as ONE work list (Overdue /
   Due Today / This Week / Later / No Set Date), a coloured tag a tool, click opens
   the tool, a total cell a tool on top. Shown by default (`QPT_HIDDEN_DEFAULT = []`).
   Stats & Awards, Processes & Policies, Store Calendar, Hotkeys, Quick Messages and
   Expense Report are in **no tab** now (Ethan: get rid of them). Employees have none
   of the three tools → no tab for them.
4. **First tab on sign-in.** Open tab is `sessionStorage` (`speeksQptTab`);
   `checkPIN` clears it, so a sign-in opens the person's first tab. Tab order /
   hidden / minis already save per person via `qp-layout` (confirmed: Ethan, Haydn
   Davis, Bret Daubert have `qpt:v1` rows server-side).
5. **Multi-Store Manager removed from the front end** (Ethan: "gone away from MSM
   entirely"; no real user held it). speeks.js (~1,380 lines), all six pages (BAL/MPL
   switcher, MSM-only Expense Report row), styles.css (removed by hand after a
   regex pass mangled comments — rebuilt from HEAD + this session's block),
   test login, check scripts. Memory note `no-multi-store-manager`.

## Open decisions / next steps

1. **DONE 11-08 (later session):** MSM code stripped from all 21 edge functions
   and deployed (verify_jwt off, as before); every one byte-checked against its
   source and OPTIONS-smoke-tested; kpi-manage/ebay-channel went out from their
   LIVE copies with the same strip, so their repo drift (mocd EXCLUDE, channel
   standby) is still unshipped. Original note follows.
   **Edge functions still hold dead MSM code** (20 functions). Ethan asked "will
   redeploy hurt?" — answered: no visible change, BUT a plain redeploy ships the repo
   copy and 2 functions have drifted:
   - `kpi-manage`: repo adds `'mocd'` to the `EXCLUDE` roster set (unshipped since
     Aug 11) — would change who is in KPI rosters.
   - `ebay-channel`: repo carries the undeployed 146-line "standby"/`channel_mode`
     feature. Deploy from the LIVE copy (`docs/quickportal/ebay-channel-live/index.ts`
     pattern from 10-28).
   - `store-comments`: comment characters only — safe.
   - The other 17 match live exactly.
   Proposed (awaiting Ethan's yes): strip only MSM code, deploy all 20, kpi-manage and
   ebay-channel from their live copies; byte-check each; smoke-test.
   Live copies were downloaded to the old session's scratchpad — re-download with
   `npx --yes supabase functions download <fn> --project-ref ejzaqmyxxrkmxvzbjeuo --workdir <scratch> --use-api`.
2. **Commit** this work (ask Ethan), then push (his OK). Not merged to pre-release/main.
3. Test account **PIN 0005 "Test MSM"** still in `test_users` — Ethan DECLINED its
   delete. Leave it.
4. Puppeteer harnesses `scripts/mobile-round15-check.js` (lines ~200, 238-244) and
   `mobile-round16-check.js` (~112-122, 198-256) still test MSM; can't run here
   (no puppeteer-core) — tidy if asked.
5. Feed / rail: Ethan never confirmed the old "homes" proposal (Connect → Store
   Health, Variance/B2B → rail); superseded by Listings & Deals.

## Known failures (pre-existing, same on HEAD)

goals-layout-check (1: `.sam-mini` rows already equal), store-calendar-check (1:
APP_VERSION 3.11.0 vs test's v3.9.1), command-center-check (6: Store Breakdown tab
removed 10-29), store-board-check (3), tablet-band-check (2: two `max-width:900px`
blocks), claims-disputes-check (runner can't read its 185k-char result).
claims-tab-check needs `-WindowSize 1440,1000`; kpi-access-check needs
`-Html workspace.html`; b2b-header-check needs `-Html b2b.html`.

## How to test

- `preview_start` config `speeksnet` → http://localhost:8080/scripts/test-login.html,
  pick a role (CEO / DM / MOCD / Store Manager / Owner / ASM / Employee / Store Board).
  Use a NEW background tab (Ethan uses the pane), `resize_window` 1440×900 for the
  desktop tabs page, reset to "desktop" after.
- Real PIN sign-in also works locally with test PINs 0000–0008 (`checkPIN`).
- Suites: `powershell -NoProfile -File scripts/browser-check.ps1 <name>` (60–120s each).

## Gotchas learned this session

- **The Bash tool collapses `\\` to `\`** in heredocs/python literals — it corrupted
  JS strings and regexes twice. Use the Edit tool for anything with backslashes, or
  build strings with `chr(92)`.
- Never regex-edit CSS by splitting selectors on commas: comments contain commas.
- A new column on a table the Claude connector reads → run
  `select ai_reader_refresh_grants();`.
- CLI deploys need `--yes` in agent mode, and Ethan's explicit OK first.
- `day-end-ingest?secret=…&days=2&goals=0` re-reads recent Day End mail without
  touching Listing Goals results.
- Ethan's preferences: designs as artifacts first (real-site look, Store + District
  switch), Title Case labels, "days" not "reports", one status palette, equal pills.
