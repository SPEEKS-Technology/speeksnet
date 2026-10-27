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
- **Added widgets + the Side Drawer** (2026-10-22, Ethan picked Option A):
  "+" in the corner (Customize only) opens `qpLibraryOpen` — search, each
  widget with Add / On Page. `QP_WIDGETS` is the registry (label, sub, icon,
  `avail` = the source tool's own gate, `render`). A widget is a block that
  exists only while the saved layout names it (`w:claims`):
  `_qpEnsureWidgets` builds them before `_qpResolve` (which drops unknown
  keys), × removes (`qpRemoveWidget`), Reset clears them, and
  `_qpOriginalKeys` leaves them out so a page with one is never "default".
  First widget: **Claims & Disputes** — the tool's four tabs (card label
  "Cases", tooltip "Cases & Disputes"), counts by `_HOLD_VIEWS.due`, Due Next
  by `due_on`, the tool's GET only (never its eBay sync POST), 2-min cache +
  `_RT_TOOL_CHECKS.claims`. Store managers only (`_claimsDueScope`).
  **Later the same day:** the key is now the plain id (`claims`, not
  `w:claims` — its colon clashed with `family:pieces`), and Claims is a card
  family (`QP_FAMILIES.claims`, kind `widget`): its four tabs are pieces
  (markers in the widget's `.sam-card`), split into `claims:returns` etc.,
  combine, × puts a piece back; × on the widget's own card removes it and
  every split-out piece. A one-piece card is titled by the piece ("Returns",
  eyebrow "OVL · Claims & Disputes"). `_qpSetEditing` redraws widgets so their
  tabs become drag handles. **Drawer rows drag onto the page**
  (`_qpLibDragStart`: `_qpDrag = {key, add}`; the drawer slides away via
  `.qp-lib-carrying`; the drop builds it with `qpAddWidget(id, t)`).
  **Operations widgets** (Ethan: build Call Backs, B2B, SPEEKS Connect; NOT
  Margin Guide or Picture Guide): every widget now draws through one painter,
  `_qpWidgetCard`, from `_QP_WSPEC[id]` = { tabs, load (the tool's own GET),
  model(data, tab) → {n, big, small, aside, sub, cap, lines, link}, ttl }.
  `_qpWLoad` caches and backs off a minute after a failure (the first Claims
  code retried on every redraw, which looped). Call Backs = In Stock (the feed
  card's suggested-match rule) · Open · Contacted; B2B = Pricing
  (`_b2bPricingDue`) · Need You (`_b2bActionFor`) · Unlisted value; SPEEKS
  Connect = Pictures · Categories from `?view=counts` (counts only — no item
  list; Titles is DM-only so left out). Realtime: `_qpWReloadB2b`,
  `_qpWReloadCallbacks` in `_RT_TOOL_CHECKS`. SPEEKS Connect needs a PIN, so
  on the test login it says "Couldn't load" — it was checked with a stubbed
  `_rcFetch` in the pane only.
  **Locked sizes:** a widget's cell never takes more than `_QP_WIDGET_MAXW`
  of a row (0.5 for all four — Ethan: stretched full width it "feels odd");
  set as an inline max-width in `_qpBuild`, lifted on phones, and the Card
  Widths strip drops options that would pass it. **No dead space** (Ethan,
  same day): sizes are ⅓·½·Full by default, the three Operations widgets
  built without Full (`_QP_WIDGET_MAXW` 0.5; Claims 1). A widget under Full
  never sits alone: `_qpPairWidgets` (in `_qpLayout` and `_qpCommit`) moves a
  lone one into the nearest row with room; Add puts it in the first row with
  room; new-row slots refuse it while dragging (red, "Needs a Card Beside
  It"); edge hints say the size it will be ("Place Beside · ⅓ Row"); with no
  room anywhere Customize shows a dashed "Add a Card Beside It" (`.qp-lone`).
  **Drawer, final shape:** slides in/out like the Checklist panel (under the
  nav, 420px, no dim; `.open`, and `qpLibraryClose` waits for the slide); no
  size pills (the drag hints say the size); widgets on the page show On Page
  + **Remove** (`qpLibraryRemove`). SPEEKS Connect has a **Titles** tab
  (listing-titles `?view=counts` → `titles` per store; `has` per tab drops a
  tab the person lacks, by its Feature Access key); `operations.html#titles`
  opens it. **Workspace widgets** (2026-10-23): Monthly Breakdown (the latest
  month the DM has filled — the tool has NO goals or projection — Net Profit
  first, four key rows with change vs the month before and place among the 5
  stores; one tab, no pieces; 5 GETs cached 10 min), Store KPIs (Weekly /
  Monthly by the reminder's own due rules; done = the Store Total judged by
  `_kpiThresholdCls` via the new shared `_kpiStoreTotals`), Variance Replies
  (To Explain / DM Notes, manager side, by `_vrMaybePopup`'s rules). Margin
  Replies was deleted from the site in its own session (a1ce290). The drawer
  has sections (`_QP_LIB_SECTIONS`: Operations, Workspace). ⚠️ speeks.js is
  CRLF in the working copy now — scripted edits must match `\r\n`.
  **2026-10-23 later:** every widget is ⅓/½ now (Claims and Monthly
  Breakdown lost Full). Variance Replies gets a made-up report on the test
  login (`_qpVarianceSample`). **First word capitalised after numbers**
  (Ethan's site-wide rule, as the feed's "1 Delete request…"):
  `_qpCapLines` fixes `.qp-hl-big small, .qp-hl-sub, .qp-hl-bs` after every
  headline / Action Items / widget draw, skipping letters glued to a number
  ("$55.4k", "3d"). A DOM scan of all five pages (test manager, visible tabs)
  found the rest only in B2B deal cards and the Call Backs header — fixed at
  the source ("33 Units", "$450 Offer", "3d In stage", "2 You can answer").
  Not scanned: modals, panels and other roles' views.
  **Sizes, final (2026-10-23):** Variance, Store KPIs, Monthly Breakdown ⅓
  only; Claims and the Operations widgets ⅓·½. `_QP_MIN_W` gives the
  Performance Chart a ½ minimum: `_qpRowLimit` caps its row at 2 cards,
  `_qpRoomIn` / Add / pairing respect it, and Card Widths offers only splits
  that keep every card within its min and max. `_qpPairWidgets` also fixes
  rows over their limit and rows of only-capped cards that leave a gap.
  **Drop to Swap:** a whole card dropped on the middle of a card from another
  group trades places with it (`_qpSwapRows`; widths kept, reset to equal if
  they break a size); if a row can't take its new card the overlay goes red
  with the reason (`_qpRowWhyNot`). **Split middle (10-23):** a whole card
  over the middle of a card from its OWN group (where either makes sense)
  gets both: top half Combine, bottom half Swap (`_qpTargetAt` takes the
  pointer's y; target carries `split: true`; `_qpShowHint` draws
  `.qp-ov-split` with two labelled `.qp-ov-half`s, the live one lit, a
  refused swap red). A tab dragged out (a piece) still only combines.
  **No full-width cards (10-23):** every card is held to ½ unless already
  held tighter (⅓-only Variance/KPIs/Monthly; chart min ½ so exactly ½):
  `_QP_DEFAULT_MAXW` in `_qpMaxW`. Defaults are now two to a row
  (feed+actions, command+district, chart+leaderboard, all equal) and go
  through `_qpPairWidgets` too (`_qpDefaultRows`), so a manager's lone
  Command Center joins the feed row. When a short row has nowhere to go,
  `_qpPairWidgets` BORROWS a ½-capable card from the nearest three-card row
  whose other two still fill it. Due Dates on its own is ⅓
  (`_QP_PIECE_MAXW['feed/due']`; a combined card takes its widest piece's cap).
  **Replace (10-23):** something NEW (a drawer widget, or a tab dragged out)
  over a card's middle shows red "Drop to Replace" (`t.zone === 'replace'`).
  Over a split-out card of the tab's own group the middle splits: top
  Combine, bottom Replace (`split: 'replace'`). `_qpRetire` puts the new card
  in its place: a widget's own card takes the whole widget off (back in the
  drawer); a split-out card's tabs go home (built-in ones too, e.g. To Do back
  into Your Feed). Built-in cards themselves refuse ("… Stays on Your Page"),
  and so does a replace that would leave a gap (`_qpReplaceWhyNot`).
  **⅔ beside a ⅓ + make room (10-25):** a manager's default page was full
  everywhere, and one ⅓-only widget had NO gap-free layout, so it could not be
  placed. `_qpCap(key, rowKeys)`: a built-in card (not a widget, held to ½ —
  chart included) may take ⅔ when its only partner is ⅓-only; used by
  `_qpBuild`'s max-width, `_qpRowWhyNot`, `_qpPairWidgets`, Card Widths and the
  drag hint (`_qpShareIn`, `_qpShareWords`). `_qpBumpPlan`: a whole card or
  drawer widget dropped on a full row's edge (or a new-row slot it can't have
  alone) is placed and the row's last card without a minimum moves to a new row
  below, then pairing fixes the rest; the hint says "… · Leaderboard Moves
  Down", a slot says "⅓ Row · Beside …" in green. Only if no gap is left —
  else the old red. **Never locked out (same day):** tabs dragged out of a card
  (Need You out of B2B) go through `_qpBumpPlan` too (it takes the drag, lifts
  the tab the way `_qpDropAt` does); every card in a full row is tried as the
  one to bump; last resort `_qpRepack` re-fits the whole page in order (hint
  "Cards Rearrange to Fit"). Add uses the same plan when no row has room.
  **Keeps its side:** a card `_qpPairWidgets` moves to another row goes in at
  the same place from the left it had (`moveTo`) — far-left B2B stays far
  left; a borrowed card goes on the far side of the one waiting.
  `scripts/qp-size-check.js` (13 pass, incl. a 60-page random sweep).
  **Processes & Policies widget (10-25):** `QP_WIDGETS.docs`, ⅓·½, everyone
  (docs.html has no Feature Access switch), own drawer section. Ethan picked
  "search bar and the pinned ones" (no category chips). `_QP_WSPEC.docs.card`
  — a new hook in `_qpWidgetCard` for a widget that is not a count — draws a
  search box + `_qpDocRows` (pinned with nothing typed; every-word match over
  title/desc/category otherwise; 5 rows then "+N More"). `_qpDocSearch` swaps
  only the list so the box keeps focus; a click counts as `doc:open`. DOCS_URL,
  10-min cache. `scripts/qp-docs-check.js` (6 pass).
  **Stats & Awards widget (10-25):** `QP_WIDGETS.stats` + `QP_FAMILIES.stats`
  (Champions / Awards / Records, split out like any widget's), ⅓·½, everyone,
  own drawer section. Ethan picked option A (the page's three views as tabs).
  The champion rules moved out of `fetchChampions` into `_champData()` (one
  WEEKLY_KPI_URL read per store, was two; result kept in `_champLast`, which
  every page fills at load for the ticker) — the page and the widget share it.
  Awards/records reuse `fetchAwardsData` / `fetchRecordsData`. Records leaves
  out GP (NP switch) and the person-held Google Reviews record. A tab may have
  no big number now (`big: null`, `room: n` in `_qpWidgetCard`). Links go
  through `_qpStatsOpen(view)` → `_statsOpenSaved()` on stats.html.
  `scripts/qp-stats-check.js` (5 pass).
  **Drag-and-drop review (10-25, Ethan approved all but touch — desktop only):**
  - **Undo:** `_qpCommit` records the layout before every change
    (`_qpUndoPush`, 30 steps, widgets included); corner button `#qpUndoBtn`
    (shown when there is a step) + Ctrl+Z; Reset is a step too (its dialog now
    says Undo brings it back). History ends at Save.
  - **One action per card middle:** the split halves (Combine/Swap,
    Combine/Replace) are gone. Same group → Combine; whole card of another
    group → Swap; something new over another group → Replace.
  - **Live preview:** `_qpPreview` — a map of the page after the drop, docked
    left of the corner buttons while dragging (green = moving, amber = moves
    too). Worked out by `_qpDropAt(main, drag, t, dry)`, so it can't disagree.
  - **Saved to the person:** `qp_layouts` (0158) + `qp-layout` function
    (GET ?user=, POST {user, rows|seen}). localStorage stays as the instant
    copy; `_qpLayoutSync` after load — server wins, a browser-only layout goes
    up the first time; never mid-Customize; saves debounced 600ms. The test
    login blocks the POST, like every write.
  - **New mark:** `_QP_WIDGET_ADDED` dates; `_qpIsNew` = added ≤30 days and not
    in `seen`; opening the drawer marks what it lists as seen (`_qpLibSeen`).
  `scripts/qp-customize-check.js` (6 pass).
  **Every role from manager down (10-26):** Customize is on by role, not
  Feature Access — `#qpBar` carries role-manager/owner-manager/assistant-
  manager/employee and no data-feature; the `qp-customize` catalog line is
  commented out. Store (board) and Training are left alone; DM/CEO/MOCD come
  with their own conversion. With Customize, `_qpHeadlinesOn` turns the
  headline cards on for those roles too. **Weekly KPIs** (the employee/ASM
  Command Center tab, cc-kpis) is now a piece (`kpis`) with a headline
  (`_QP_HL_BUILD.kpis`, Ethan's option A: "N of M on target", the misses with
  goal + store, on target on one line), fed by `fetchAndRenderEmployeeKPIs`
  through the same `checkRule`. Four tabs in a ⅓ card use short labels
  (`.qp-many-tabs`, `.cc-tl`/`.cc-ts`). `_qpSettle` = pairing + a re-fit
  (`_qpRepack`) whenever a row still breaks a size rule — commit, load and
  default all go through it. Checks: 15 pass in qp-customize-check.js. A test row `zz-claude-test` may
  still be in qp_layouts (its delete was declined).
  The Leaderboard card is white on its own (`.ew-perf-lb .ew-standings`).
  **Test login:** SPEEKS
  Connect gets SAMPLE counts when `_speeksTestSession` and no PIN (like
  `_lvTestPayload`).
  Not yet: drawer categories, DM oversight versions, more widgets (Variance,
  Recycle suggested).
- **Site-wide tab look** (2026-10-22): every `.notif-tabs` bar of `.tab-btn`
  (all five pages: Claims, Checklist/Cleaning panels, Feature Access, Quick
  Messages, manage modals…) and the Listing Goals `.timeframe-toggle` take the
  `.cc-seg` look — LOOK ONLY, sizes stay each bar's own (styles.css, ONE TAB
  LOOK, SITE-WIDE, at the end; doubled classes + !important outrank the
  Checklist panel's own !important). Left alone: `.ws-subtabs` (the underlined
  page menu at the top of Workspace/Operations) — a different control.
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

- DM design (shown inline 10-26): A = District Command Center pieces with
  headlines (Live, Matrix, Store Breakdown, eBay, Scorecard); B = DM Action
  Items cards — DONE 10-26; C = district versions of drawer widgets (Variance
  review queue, Claims by store, Store KPIs by store; later B2B, Call Backs,
  Connect Titles). Ethan: B first, then A, then C one widget at a time.
- CEO: on live Feature Access the CEO has no Action Items rows, so Your Feed's
  only partner is the District card, at ½ (408px, its panels overflow). Part A
  (district headlines that fit ½) is the fix.
- When it ships, bump the cache-buster (`?v=`) in all five HTML pages
  (`CLAUDE.md` rule 3). `APP_VERSION` with the release.
- **Save layouts to the database** so they follow a person across devices
  (new table + edge function; check `list_migrations` before numbering).
- Customize is hidden on phones; drag doesn't work on touch.
- Then, per the mockup: DM role, widget library ("Add widget"), "Needs you"
  alerts widget, usage-based suggestions, Gmail connector, Ask/report widgets.
- A real test account for other people needs a "test" marker that every
  backend skips (`store-targets`, `kpi-manage`, `usage-report`, `notify`).
  **10-26 later:** ASM/employee Action Items get their cards too (the
  `_isPersonalGoalsUser` gate in `_qpRenderActions` is gone); their Listing
  Goals card is their own (`_qpAiMyListing` — today's role + goal, the week day
  by day, from `window._empWeek` set in the employee goals loader). Weekly KPIs
  misses show Goal and Store as separate tags (`_qpKpiTag`). **Multi-store
  managers keep a layout per store**: `_qpLayoutStore()`; local key
  `…<name>@<store>`, qp-layout takes `store=` (row `<name>@<store>`, falls back
  to the plain row until that store has its own; `seen` stays on the plain row).
  qp-layout redeployed 10-26. Feed lists stop 14px above the card corner.
  **10-26, DM/CEO/MOCD:** Customize for DM, CEO and MOCD (`#qpBar` role
  classes). **District Action Items cards** (`_qpAiDmCleaning` / `_qpAiDmGoals`
  / `_qpAiDmListing`, `district: true` in `_QP_AI_PIECES`): five stores worst
  first, from the popups' own reads; Cleaning has Daily / Weekly; Listing counts
  RESULTS like the manager card (the popup's "listed" is assigned goals); a
  store with no goal this week says Not Set. Eyebrow "District · …".
  `_dmxSyncRail` redraws them. **Only Customize pages are held to ½**:
  `_qpMaxW` returns 1 when `!_qpHeadlinesOn()` — the store board's one Live
  card is full width again, and anyone without Customize keeps full panels.
  The size/docs/stats checks stub `_qpHeadlinesOn` true for that reason.
  **District card keeps a full row** (`_QP_BLOCK_MAXW`, min ½) until part A.
  **10-26, even tabs, site-wide:** every button in a tab bar or switch is
  as wide as its widest (`_eqTabsRun`, EVEN TABS at the end of speeks.js:
  inline min-width from offsetWidth, re-run by a MutationObserver, backs off
  if the bar would overflow). Groups are listed in `_EQ_TAB_GROUPS` — a new
  kind of tab bar has to be added there. Team Goals (district) rows are
  Set / Not Set pills now, all five stores. Feed empty lines Title Case.
  Recent Activity title capped at 30ch.
  **10-26, part C (district widgets):** three drawer widgets for DM/CEO —
  `dvariance` Variance Review (To Review / Stores, from `_vrDmTriage`, lifted
  out of checkVarianceDmReminders so both read one rule; DM only),
  `dclaims` Claims & Disputes (oversight read, `_qpClaimsSplit`, a line a
  store, overdue first; gate tool-claims-oversight), `dkpis` Store KPIs
  (Due / Overdue / N Of M green a store, 10 GETs cached 10 min). Realtime via
  the existing _qpClaimsReload / _qpWReloadKpis / _qpWReloadVariance.
  **District card never shares its row** now (`_QP_MIN_W.district = 1`):
  a widget added beside it made the row 900px. So the CEO's feed sits alone
  at ½ until something is added beside it (dclaims/dkpis fill it).
  Not built yet from part C: B2B pricing, Call Backs by store, Connect Titles.
  APP_VERSION 3.11.0 (main is 3.10.1; patch notes for v3.11.0 still to
  write), cache-buster 20261026i.
  **10-26 late:** `dconnect` (district SPEEKS Connect: Pictures / Categories /
  Titles a line a store; same ?view=counts reads, corp-scoped for DM/CEO).
  District cards show all five stores (`room: 5` → `.qp-ai-dense` and a
  `.qp-cw-grid` subgrid so pills are one width). Records with no store (DM/
  CEO/MOCD) shows who holds each record. Stats & Awards on its own: a card
  holding only Champions or only Awards draws `_QP_WSPEC.stats.solo[tab]`
  (podium tiles; award hero + past winners + year tally; container query at
  ⅓). Drawer X = .modal-close-btn, rows 10px side padding, two-line subs.
  B2B already covers DM/CEO (All Stores) — not a part C item.
  **10-26, widget enhancements (ideas 1, 2, 3, 4, 6; 5 = clickable lines left
  out):** store dots in `_qpWLineS` / `_qpAiStoreRow` / Records; all-clear
  state (`clear: [title, line, last?]` on a model → `.qp-clear`); trend vs
  last week (`_qpWeekTrend` Mon–yesterday vs same days, so none on a Monday;
  KPIs `trend` vs the period before); checklist progress ring
  (`_qpAiChecklist`, Next Up one line shorter); "Updated … ago" + refresh
  (`.qp-upd`, lv-ago, `_qpAgoTimer`). Height sweep: every widget, every tab,
  every piece split out, six roles at 1440 + manager at 1280 — all 350.
  **10-26 (later):** time-ago text is Title Case everywhere it is generated
  (`_lvAgo`, `_siRelTime`, `_ecAgo`: "Just Now", "4m Ago"). The refresh pill
  is ONLY on Claims (store + district) and SPEEKS Connect (store + district)
  (`spec.synced`); Claims shows "Synced N Ago" from the read's sync /
  disputeSync / paymentSync `synced_at`, the OLDEST store's (`_qpClaimsSyncedAt`);
  Connect has no sync time in its counts, so it shows when the card read it.
  The Champions / Awards views also draw under the Stats & Awards tabs
  (`qp-solo-tabbed`), for every role; no-store eyebrow is "Company · All Stores".
