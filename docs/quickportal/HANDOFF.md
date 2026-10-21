# QuickPortal revamp — handoff (2026-10-21)

Picking this up in a new session? Read this first, then `CLAUDE.md`.

## Where the work is

- **Folder:** `C:\Users\User\Documents\GitHub\speeksnet-nov3` — a git worktree.
- **Branch:** `Main-November-Update-3---Ethan`, cut from `origin/pre-release` at `b8dbb73`.
- **Committed and pushed** to origin (`563fc68` + `b7ff25f`, 2026-10-21). Only
  `.claude/launch.json` is left untracked, on purpose (local config). Pull
  before working on it from another machine or the cloud.
- **Don't touch `C:\Users\User\Documents\GitHub\speeksnet`.** That folder is a
  separate session's: `Main-November-Update-2---Ethan`, Picture Quality work,
  with an uncommitted local-only un-park in `speeks.js` and untracked
  `scripts/pq-gold/*` label files. In GitHub Desktop, switch *repositories*,
  never branches inside that folder — doing so once stashed the PQ files.
- Shared: the git stash stack, and the live Supabase database (migrations and
  edge-function deploys from either folder hit production).

## What the project is

Ethan's plan: turn QuickPortal into a customizable dashboard — move cards,
resize, split and combine them, and later add widgets (email/notification
connectors, usage-based "suggested for you", Claude-backed report/Ask widgets).
He wants it done **very slowly, one small step at a time, in the site's
existing look**, starting with the manager role (then DM).

Design mockups (private Claude artifact, two artboards — the DM dashboard
vision and the split/combine interaction):
https://claude.ai/artifact/EKHSeqS3NmN2jhbfunPdM8

## What's built

**Customize mode** on QuickPortal, managers only (`qp-customize` in
`FEATURE_CATALOG`, `speeks.js` ~44057 — widen it from Feature Access):

- Top of page: a bar with **Customize** → in edit mode **Reset to Default** +
  **Save**, then the High Priority bar (pinned, never moves). Customize sits
  ABOVE the banner (Ethan: under it looked odd). No instruction text.
- **Edit mode = dashed outline on every card, the whole card is the handle**
  (no drag bars — tried twice, dropped; see styles.css "THE WHOLE CARD IS THE
  HANDLE"). Nothing inside a card can be clicked in edit mode (pointer off in
  CSS + capture-phase `_qpBlockClicks`); piece grips stay draggable only.
- **Every card in a row is the same height** — the Action Items card stretches
  its frame, its rows keep their own height.
- **Nothing moves when a drag starts**: drop slots live inside the 22px row
  gaps and show a green line; the width strips go `visibility: hidden`, not
  `display: none`. "Place beside" is a green line in the gap beside a card.
- Blocks (`data-qp-block` in `index.html`): `feed`, `actions`, `links`,
  `command`, `district` (DM/CEO), `chart`, `leaderboard`. The old feed deck and
  Performance card were each split into two blocks.
- **Rows of 1–3 cards.** Drag a card: near another card's left/right edge →
  "Place beside"; into the gap between rows → its own row; a full row says
  "Row is full · 3 max". No arrow buttons (removed on request).
- **Card widths** strip above any two-card row: "Same width / X wider / Y
  wider" with little pictures (fractions were rejected as unclear).
- **Card pieces:** the Command Center (Live Sales, eBay, Scorecard & Audit — one
  per tab) and Action Items (one per row) can be split and recombined in any
  combination. Drag a tab/row out to a card edge or a +; drag a card over the
  **middle** of a same-group card → "Drop to combine — Makes one card: …".
  Split cards reuse the *real* elements (moved with their ids), so all existing
  renderers keep filling them.
- Default layout = today's page exactly. Layout saves **per person in
  localStorage** (`speeksQpLayout_<name>`), not the database yet.

## Where the code is

- `speeks.js`
  - `// QUICKPORTAL LAYOUT` (~49609) — the whole module. The banner comment
    explains the model (rows → cards → pieces, shells, keys like
    `command:ebay,score`). Entry point `_qpApplyLayout()`, called at the end of
    `applyRoleBasedUI` (~32848).
  - `// --- TEST SESSION` (~68) — local test login support (see below).
  - `_tabSwitch` (~12882), `_tabCollapse`, `_openDefaultTab` (~13118) — now
    scoped to the card a tab sits in (needed for split Command Center cards).
  - `samInit` / `_samSyncRailFill` — rail lookups point at
    `[data-qp-block="actions"] .sam-rail` (a split card adds a second rail).
  - `handleSignOut` — also clears the test-login restore copy.
- `styles.css` — `QUICKPORTAL LAYOUT — rows of 1–3 cards…` section at the end (~25243).
- `index.html` — `CUSTOMIZE BAR` comment (~719) and the `data-qp-block` tags.

## How to run and test it

1. Serve this folder on **port 8081** (the PQ session uses 8080):
   `python scripts/serve-local.py 8081` (the `speeksnet-nov3` entry in
   `.claude/launch.json`). Note: `preview_start` in the Claude app once started
   the *other* folder's config instead — check what it serves.
2. Open `http://localhost:8081/scripts/test-login.html` → **Sign in as OVL
   Manager (test)**. There is deliberately **no account in the database**: a
   real OVL manager row would change OVL's listing goal (`store-targets`), KPI
   roster, usage report and nudges. The test session (localhost only) blocks
   every non-GET call to Supabase (allow-list `READ_POSTS` for read-only POSTs);
   Live tab and leaderboard need a real PIN, so they stay "Syncing" for it.
3. The Claude desktop browser pane wipes sessionStorage when it re-opens a tab;
   the test login keeps a localhost-only copy (`speeksTestRestore`) and restores
   itself. Sign Out clears it.
4. `powershell -File scripts/browser-check.ps1 b2b-check.js` — last run 292
   passed, 0 failed (2026-10-21, after whole-card drag).
5. Ethan's own test layout lives in the pane's localStorage
   (`speeksQpLayout_test manager ovl`) — back it up before testing, put it back after.

## Lessons that cost time (don't relearn them)

- **Never change the layout inside `dragstart`** — Chrome cancels the drag.
  Defer to `requestAnimationFrame`. Simulated drag events don't catch this;
  always also test with a **real mouse drag** (`left_click_drag`).
- Rebuilding rows briefly shrinks the page → scroll jumps to top; wrap commits
  in `_qpKeepScroll`.
- `.employee-widget-card` carries `max-width: calc(33.33% - 20px)`; split
  Command Center cards need `max-width: none !important`.
- The feed card uses `contain: size` on `.sam-feed` so a long feed doesn't
  stretch its row.
- **Anything added to or removed from the flow when a drag starts moves the
  page under the mouse** and the drop lands somewhere else. Keep drop targets
  inside existing space.
- A drag near the window edge auto-scrolls the page: take a fresh screenshot
  before the next `left_click_drag`, or you aim at stale positions and it looks
  like the drag failed.
- A split-out shell never passes through `applyRoleBasedUI`, so it doesn't get
  the inline `display:flex` the originals get — give shells layout in CSS.
- The mockup artifact link below 404s from this account (2026-10-21); designs
  were shown inline in chat instead.

## Not done / next steps

- When it ships, bump the cache-buster (`?v=`) in all five HTML
  pages when it ships (`CLAUDE.md` rule 3). `APP_VERSION` with the release.
- **Save layouts to the database** so they follow a person across devices
  (new table + edge function; check `list_migrations` before numbering — the
  database, not the checkout, is the authority; max was 0149 on 2026-10-16).
- Customize is hidden on phones; drag doesn't work on touch.
- Split-out Action Items still look like a rail row; the mockup's bigger single
  card (count, bar, "next up" list) needs new content.
- Then, per the mockup: DM role, widget library ("Add widget"), "Needs you"
  alerts widget, usage-based suggestions (`usage` table already logs opens),
  Gmail connector (Workspace?), Ask/report widgets via the `speeks-mcp` tools.
- A real test account for other people to try it needs a "test" marker that
  every backend skips (`store-targets`, `kpi-manage`, `usage-report`, `notify`).
