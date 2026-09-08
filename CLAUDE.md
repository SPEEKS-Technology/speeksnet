# SPEEKSNET — working notes for Claude

Internal ops site for SPEEKS Technology (PayMore franchisee, Kansas City & St.
Louis). Static front end on GitHub Pages + Supabase (Postgres, Deno edge
functions). Live at speeksnet.com (see `CNAME`).

**Read `docs/modules/README.md` for the line-range map of `speeks.js`, and load
only the area you're working in.** That file exists because `speeks.js` is 47k
lines in one file — reading it whole wastes most of a context window.

---

## The five things that will bite you

1. **`speeks.js` is hand-written, monolithic, and NOT generated.** ~47,200 lines,
   ~2.5 MB, non-minified. There is no build step, no bundler, no `package.json`,
   no lockfile. Nothing produces this file and nothing consumes it but the
   browser. Edit it in place.

2. **Everything is a global, and handlers are inline HTML attributes.** Functions
   are called from `onclick="..."` in the `.html` files *and* from `${...}`
   template strings inside `speeks.js` itself. **Do not convert to ES modules** —
   `import`/`export` puts everything in module scope and silently breaks every
   inline handler. If you split the file, it has to be ordered classic
   `<script>` tags or explicit `window.*` exports.

3. **Ship a JS/CSS change → bump the cache-buster in every HTML page.** Assets
   are served raw with a hand-maintained query string, e.g.
   `<script src="speeks.js?v=20260903k" defer>` (`index.html:28`). The five pages
   that carry it: `index.html`, `operations.html`, `workspace.html`, `stats.html`,
   `docs.html`. Forget this and users keep the old file.

4. **Migration numbers are already duplicated.** Two parallel work streams both
   numbered from the same base, so there are two each of `0004`–`0009` and
   `0044`–`0054`. **The current max is `0066`** — new migrations start at `0067`.
   Never derive the next number by incrementing what you happen to be looking at.

5. **Migrations are applied through the Supabase MCP `apply_migration`,** not a
   CLI runner. The files in `supabase/migrations/` are the provenance record. The
   MCP server needs authorizing in an interactive session before any schema work.

---

## Layout

| Path | What it is |
|---|---|
| `index.html` | Dashboard / home. Every other page bounces here without a session. |
| `operations.html` | Sub-tab shell for operational tools — **B2B lives here** (`#ops-pane-b2b`). |
| `workspace.html` | Analytics workspace — Monthly Brief, Store KPIs, Variance. |
| `stats.html` | Stats/reporting page. |
| `docs.html` | *Not* developer docs — the in-app Processes & Policies library (CMS-driven). |
| `tv.html` | Lobby/TV display. |
| `speeks.js` | The entire front end. See `docs/modules/README.md`. |
| `styles.css` | ~970 KB, same monolithic story. |
| `xlsx.full.min.js` | Vendored SheetJS. Third-party — don't edit. |
| `supabase/functions/` | 63 Deno edge functions. |
| `supabase/migrations/` | 86 SQL files. Read the header comments — they explain *why*. |
| `tools/b2b-capture/` | Standalone PowerShell bench hardware-capture toolchain. Zipped and distributed **through the app** (Operations → B2B Deals → SPEEKS Capture), not from the repo. Has its own README. |
| `scripts/` | ~33 headless Puppeteer verification harnesses (`*-check.js`). |
| `prototypes/` | Throwaway sandboxes, not linked from the app. |
| `google-apps-scripts/` | `.gs` files for Sheets/Gmail-side imports. |
| `docs/modules/` | The context maps. Start here. |

## Conventions worth matching

- **Comment headers carry the reasoning.** Both `// --- section ---` and
  `// ====` banner blocks. They routinely explain *why* a thing is deliberately
  odd — read the banner before changing code under it, and when you make a
  non-obvious call, add to it in the same voice.
- **Store codes:** `['OVL','LEE','WSP','MPL','BAL']` (`speeks.js:118`), `CORP`
  added for tints and for B2B pricing locations. Multi-store managers:
  `['BAL','MPL']` (`speeks.js:24721`).
- **Edge function URLs** are all declared together at `speeks.js:63-113`.
- **Roles:** CEO / MOCD / DM / manager / store. `0028_tom_to_mocd_cutover.sql`
  records the TOM→MOCD rename.
- Feature visibility is DB-driven (`feature-access` function, `FEATURE_CATALOG`
  around `speeks.js:33979`). A parked feature is hidden by commenting out its
  catalog entry, which makes `_featureEffectiveVisible` false.

## Identity — important limitation

There is **no `user_id` or FK anywhere** in the app schema. Attribution is a
free-text display name read from the browser: `_b2bUser()` (`speeks.js:15783`)
returns `sessionStorage.getItem('speeksUserName') || 'Unknown'`, passed in the
request body. So all "who did this" data is spoofable by editing sessionStorage
and breaks on a name change. Any feature that needs trustworthy per-person
attribution (scorecards, variance-by-employee) needs real identity first.

## Verifying a change

**Start here — this one actually runs today:**

```
powershell -File scripts/browser-check.ps1 b2b-check.js         # behaviour
powershell -File scripts/browser-check.ps1 b2b-layout-check.js  # rendering
```

Two suites, because they catch different things. `b2b-check.js` asserts about
the HTML a renderer returns — it cannot see a row overflowing its grid or a
control rendered at zero size. `b2b-layout-check.js` loads the real
`styles.css`, puts markup in the DOM at 390 / 820 / 1440px and **measures**.
It found a bug no string assertion could: the Overview cards set
`overflow: hidden` for their radius, which clipped five-column tables on a
phone so the right-hand columns were unreachable with no scrollbar to say so.
Add to the layout suite whenever you add markup that can wrap, scroll or clip.

`scripts/browser-check.ps1` drives headless Chrome directly, so it needs **no
Node and no npm**. It loads `speeks.js`, parse-checks the whole file (a syntax
error anywhere means no function gets hoisted, which the probe catches), then
runs the assertions in the named `scripts/*-check.js` file. Write checks as
`t('name', function () { return true; /* or a string explaining the failure */ })`.
Exit code is non-zero if anything fails. Add `-Keep` to keep the generated
harness page for debugging.

Traps the runner documents and works around — don't "simplify" any of them:

- **Blocking dialogs are fatal.** `alert`/`confirm`/`prompt` never return in
  headless, so one call hangs the run with no output and no error. `speeks.js`
  reaches for `alert()` readily (`_b2bSay` falls back to it whenever its footer
  element is absent, which it always is in a harness). The runner replaces all
  three with recorders and reports what was suppressed.
- **The network is blocked** and reported, because a file:// request fails
  slowly and lands in a `.catch()` long after the test that caused it finished.
- Chrome's `--dump-dom` output only arrives on the merged `2>&1` stream here.
- Merging a native command's stderr in PS 5.1 wraps each line in an ErrorRecord
  that aborts the script under `$ErrorActionPreference = 'Stop'`.
- Passing `--user-data-dir` makes headless Chrome die with "Multiple targets are
  not supported in headless mode".

Writing checks: stub `_b2bSend` **once at the top of the file**, not per-test.
Saves go through `_b2bEnqueue`, which sends in a promise callback — a per-test
stub restored in a `finally` is already gone by the time the send runs, and the
real one then hits the network. For the same reason, assert on synchronous state
(a cleared pending set) rather than on a payload having been posted.

A run takes 60–120s. Start it in the background rather than assuming a hang. If
you must clean up Chrome, filter on `--headless` in the command line
(`Get-CimInstance Win32_Process`) — the user's own browser runs on this machine.

- **`node scripts/<name>-check.js`** — the older Puppeteer harnesses. They need
  `npm i puppeteer-core` once, anywhere on the path (no repo `package.json`), and
  Chrome at `C:/Program Files/Google/Chrome/Application/chrome.exe`.
  ⚠️ **Node is not currently installed on this machine**, so none of these run as
  things stand. They resolve the repo root from `__dirname`, so they work from
  any checkout location once Node exists.
- Two traps `scripts/mobile-check.js` documents and exists to avoid: a narrow
  desktop window is not a phone (needs real mobile emulation), and every non-index
  page redirects to `index.html` without a seeded session — so measuring
  `operations.html` without `--fake=role-manager` silently measures `index.html`.
- There is **no test suite** and no CI build. `.github/workflows/main.yml` is only
  a branch-policy check: `main` may only be merged into from `pre-release`.

## Git flow

`main` ← `pre-release` ← `release/vX.Y.Z`. Version constant `APP_VERSION` at `speeks.js:42`
(`0. APP VERSION`) — bump it with the release. Patch notes are a DB-backed
in-app feature (`patch-notes` function, editor around `speeks.js:31582-31909`).
