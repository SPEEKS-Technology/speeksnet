# QuickPortal revamp — handoff (2026-10-22)

Picking this up in a new session? Read this first, then `CLAUDE.md`.

## Where the work is

- **Folder:** the main checkout, `C:\Users\User\Documents\GitHub\speeksnet`.
  The `speeksnet-nov3` worktree was removed on 2026-10-22 (Update 3 became a
  normal branch here; Update 2 was deleted). Any older note naming
  `speeksnet-nov3` now means this folder.
- **Branch:** `Main-November-Update-3---Ethan`, cut from `origin/pre-release` at `b8dbb73`.
- Other sessions work in this same folder and branch (Listing Health, reports…),
  so commit only the QuickPortal files and check `git diff` for anyone else's
  edits before committing.
- Shared: the git stash stack, and the live Supabase database (migrations and
  edge-function deploys hit production).

## What the project is

Ethan's plan: turn QuickPortal into a customizable dashboard — move cards,
resize, split and combine them, and later add widgets (email/notification
connectors, usage-based "suggested for you", Claude-backed report/Ask widgets).
He wants it done **very slowly, one small step at a time, in the site's
existing look**, starting with the manager role (then DM). Show a design
before building anything new; labels in Title Case.

Design mockups (private Claude artifact, two artboards — the DM dashboard
vision and the split/combine interaction):
https://claude.ai/artifact/EKHSeqS3NmN2jhbfunPdM8 — 404s from Claude's account;
designs since have been shown inline in chat.

## What's built

**Customize mode** on QuickPortal, managers only (`qp-customize` in
`FEATURE_CATALOG` — widen it from Feature Access):

- Top of page: a bar with **Customize** → in edit mode **Reset to Default** +
  **Save**, then the High Priority bar, then **Quick Links** — both pinned, never
  move. Quick Links is not a block any more (2026-10-22); a saved layout naming
  `links` just drops the key.
- **Edit mode = dashed outline on every card, the whole card is the handle**
  (no drag bars — tried twice, dropped). Nothing inside a card can be clicked
  in edit mode (pointer off in CSS + capture-phase `_qpBlockClicks`); piece
  grips stay draggable only.
- **Nothing moves when a drag starts**: drop slots live inside the 22px row
  gaps (green line); width strips go `visibility: hidden`. **Edge scrolling**:
  hold a card near the top/bottom of the window and the page scrolls
  (`_qpEdgeScroll`).
- **Rows of 1–3 cards**; **Card Widths** strip above a two-card row:
  "X Wider | Same Width | Y Wider" (Same Width in the middle).
- **Card pieces:** the Command Center (Live Dashboard, eBay, Scorecard & Audit)
  and Action Items (one per row) split and recombine. A split-out card has an
  **×** in edit mode that puts it back into its family's original card in its
  usual place (`qpPutBack`).
- **ONE CARD HEIGHT:** every card in a row is at least 350px, so every row is
  350 (Quick Links excepted). The Performance chart and Leaderboard fill their
  card instead of the old fixed 380px.
- **Command Center — no summary view.** Tabs only switch, never collapse; a
  card opens on its first tab (Live Dashboard first, `CC_TABS` order).
  - **One tab** (`data-qp-single`): no tab button; title "OVL Command Center ·
    eBay"; shows a **headline view** (`_QP_HL_BUILD` live / score / ebay) that
    opens nothing. eBay and Scorecard show everything their panel did; Live has
    **Today / Yesterday / Month**, Projected Month-End boxes, the latest order,
    **Open Full Dashboard** (the board over the page, not in the card),
    Daily Breakdown and the sale chime.
  - **Two or more tabs** (`data-qp-hl`): normal-size tab buttons, title "OVL
    Command Center", and the OPEN tab's headline in place of the panel — a
    leaner version (`h.compact`) so it fits 350 with the tab bar.
  - Headline data comes from each tab's own loader (`_qpSetHeadline` in
    `fetchScorecardData`, `fetchAlertsData`, `renderLiveDashboard`) — no second
    fetch. Desktop only: phones keep the tab panels.
- **Action Items cards** (`_qpRenderActions`, 2026-10-22): a card holding one
  piece shows it as a card — count + bar + Next Up for the two checklists (with a
  Daily / Weekly / Monthly / Quarterly switch, only periods that have tasks),
  each person's listed/goal for Listing Goals (results vs assigned — the old rail
  "200/292" was ASSIGNED goals, not listings), the month's goals/initiatives for
  Goals & Initiatives. Two or more pieces → "Action Items" with tabs + counts. The
  rows stay in the card, hidden (the layout reads them); in Customize the TABS
  are the drag handles (`data-qp-drag-piece`). Managers only, desktop only.
- **Your Feed tabs and pieces** (2026-10-22): Customize users on desktop get
  All · Due · To Do · News tabs (equal width, a grid), and All shows the three
  groups under labels. Due = a reminder with `kind: 'due'` in
  `_samReminderCfg` (always red); News = announcements, messages, patch notes
  and `noDue` reminders; To Do = the rest. The feed is a third family
  (`QP_FAMILIES.feed`): its pieces are empty markers (`.sam-fpiece` in
  index.html) the layout moves between cards, and `_samPaintFeedCard` paints
  each feed card from the markers it holds. One-kind cards are titled by the
  kind and have no tabs; in Customize the tabs are the drag handles.
  Not done: real due DATES and Overdue / Today / This Week groups (claims, B2B
  pricing and variance need to stamp their dates on their bubbles first).
- **Customize is a corner button** (2026-10-22): 30px round icons fixed
  bottom-right in `.main-content`'s 50px right padding (never over a card);
  Reset stacks above Save. z-index 100, under the side panels (101).
- **One tab look** (2026-10-22): every tab bar and switch on the QuickPortal
  uses the Command Center's `.cc-seg` design (styles.css, ONE TAB LOOK at the
  end). Tab bars (feed, Action Items) at the CC size, max 440px; small switches
  (Daily/Weekly, Today/Yesterday/Month, chart and leaderboard toggles) the same
  look at 26px tall so cards stay 350. The one-tab Live card was 351–352px on
  Yesterday/Month (older than the tab change); `.qp-hl-footrow` padding-top
  10→8 fixed it — 350 everywhere at 1280/1366/1440.
- **Reset to Default asks first** (2026-10-22): an HTML dialog (`qpReset` →
  `_qpResetNow`), Cancel focused; Escape and the backdrop cancel.
- **Quick links removed for everyone** (2026-10-22): B2B Records and Training,
  links and catalog keys; the DM's Resources bar went with them.
- **Headline views are for Customize users only** (`_qpHeadlinesOn`): everyone
  else, and the store TV board, keep the full Command Center panels and rows.
- Layout saves **per person in localStorage** (`speeksQpLayout_<name>`), not the
  database yet.

## Where the code is

- `speeks.js`
  - `// QUICKPORTAL LAYOUT` — the whole module. Entry point `_qpApplyLayout()`,
    called at the end of `applyRoleBasedUI`. Headlines: `_qpRenderHeadlines`,
    `_QP_HL_BUILD`, `_qpLivePast`, `qpLiveMode`.
  - `// --- TEST SESSION` (~68) — local test login support (see below);
    `_lvTestPayload` (beside `fetchLiveDashboard`) — sample live data.
  - `_tabSwitch`, `switchCommandTab`, `_ccSyncCompactOpen`, `_ccOpenDefaultTab`
    — Command Center tabs never collapse; card-scoped for split cards.
  - `openLiveFullscreen(false)` — the board filling the window without the
    browser's real full screen (Live's "Open Full Dashboard").
- `styles.css` — the `QUICKPORTAL LAYOUT` section at the end: ONE CARD HEIGHT,
  ONE-TAB CARDS, HEADLINE VIEW.
- `index.html` — `CUSTOMIZE BAR`, `QUICK LINKS — pinned`, `.qp-cc-piece` in the
  Command Center title, and the `data-qp-block` tags.

## How to run and test it

1. `preview_start` with the **`speeksnet`** launch config → port **8080**
   (`python scripts/serve-local.py`).
2. Open `http://localhost:8080/scripts/test-login.html` → **Sign in as OVL
   Manager (test)**. There is deliberately **no account in the database**: a
   real OVL manager row would change OVL's listing goal (`store-targets`), KPI
   roster, usage report and nudges. The test session (localhost only) blocks
   every non-GET call to Supabase (allow-list `READ_POSTS` for read-only POSTs).
   Live sales need a real PIN, so the test session gets made-up SAMPLE live data
   (`_lvTestPayload`) — Live card, full Live view and Leaderboard fill from it.
   Buying, Scorecard, eBay, Daily Breakdown and the chart are real.
3. The Claude desktop browser pane wipes sessionStorage when it re-opens a tab;
   the test login keeps a localhost-only copy (`speeksTestRestore`) and restores
   itself. Sign Out clears it.
4. **The pane is often ~800px wide = the phone layout**, where headlines and
   Customize are off. Use `resize_window` 1440×900 to test desktop, and reset
   it with preset "desktop" afterwards.
5. `powershell -File scripts/browser-check.ps1 b2b-check.js` — last run 292
   passed, 0 failed (2026-10-22).
6. Ethan's test layout lives in the pane's localStorage per PORT
   (`speeksQpLayout_test manager ovl`) — back it up to a file before testing
   and put it back after. He rearranges it between turns; restore the latest.

## Lessons that cost time (don't relearn them)

- **Never change the layout inside `dragstart`** — Chrome cancels the drag.
  Defer to `requestAnimationFrame`. Always also test with a **real mouse drag**.
- Rebuilding rows briefly shrinks the page → scroll jumps to top; wrap commits
  in `_qpKeepScroll`.
- `.employee-widget-card` carries `max-width: calc(33.33% - 20px)`; split
  Command Center cards need `max-width: none !important`.
- **Anything added to or removed from the flow when a drag starts moves the
  page under the mouse.** Keep drop targets inside existing space.
- A drag near the window edge auto-scrolls the page: take a fresh screenshot
  (or click by element ref) before the next action.
- With an emulated viewport, screenshot positions and click positions don't
  match — click by `find` ref instead.
- A split-out shell never passes through `applyRoleBasedUI`, so it doesn't get
  the inline `display:flex` the originals get — give shells layout in CSS.
- The original Command Center's `data-qp-block` is on the `.ew-dash` wrapper,
  not on `#ccWidget` — selectors need both (`:is(...)`).
- **Real drags in the pane under emulation** (2026-10-22): `left_click_drag`
  scales its START by viewport/800 (1.8 at 1440) but its END by ~1.22, so
  compute both from `getBoundingClientRect` and divide separately. A missed
  drag that started on page text leaves a selection behind, and the next drag
  becomes a text drag (dragstart target is a #text node) — clear it with
  `getSelection().removeAllRanges()` first. Log dragstart/dragover/drop.
- Every new line on a headline card costs height: measure all three Live modes
  × every tab at 1/3 width before calling it done (target 350).

## Not done / next steps

- DM/CEO Action Items pieces (dmcleaning, dmgoals, dmlisting) still show as rows.
- When it ships, bump the cache-buster (`?v=`) in all five HTML pages
  (`CLAUDE.md` rule 3). `APP_VERSION` with the release.
- **Save layouts to the database** so they follow a person across devices
  (new table + edge function; check `list_migrations` before numbering).
- Customize is hidden on phones; drag doesn't work on touch.
- Then, per the mockup: DM role, widget library ("Add widget"), "Needs you"
  alerts widget, usage-based suggestions, Gmail connector, Ask/report widgets.
- A real test account for other people needs a "test" marker that every
  backend skips (`store-targets`, `kpi-manage`, `usage-report`, `notify`).
