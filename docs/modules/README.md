# `speeks.js` module map

47,220 lines in one file. This is the index: find your area, load **only** that
line range, work there. Ranges run to the start of the next entry.

Headers in the file come in two styles — `// --- name ---` and `// ====` banner
blocks. Both usually explain *why* the code below is shaped the way it is. Read
the header before changing anything under it.

Deep-dive docs live beside this file. Right now: [`b2b.md`](b2b.md).

## Foundations (1 – 1,890)

| Line | Area |
|---|---|
| 29 | `0. APP VERSION` — `APP_VERSION` at :42, single source of truth |
| 63 | `1. API URLS` — every edge-function URL, declared together |
| 113 | Shared store roster (`STORE_CODES`, `STORE_DOTS`, tints) |
| 124 | Write helper |
| 143 | Usage telemetry (`usage_events`) |
| 365 | `2. NAV COMPACT MODE` |
| 416 | `3. GLOBAL HELPERS & UTILITIES` |
| 452 | `4. GLOBAL UI, MODALS & TABS` — incl. `closeAllModals()` at :482 |
| 1393 | Announcement reaction logic |
| 1580 | Reaction live polling |
| 1634 | `4B. INFO TICKER` |

## Core app (1,891 – 9,780)

| Line | Area |
|---|---|
| 1891 | `5. USER MANAGEMENT` |
| 2191 | `6. HUB / HOTKEYS` |
| 2229 | `7. DOCS & POLICIES` (drives `docs.html`) |
| 2708 | `8. AUTH & DASHBOARD CORE UTILITIES` |
| 3008 | `9. MONTHLY KPI DASHBOARD` |
| 3166 | `10. LIVE VARIANCE REPORTS` · 3290 variance input tool |
| 3401 | `11. WEEKLY KPI GRID` · 3551 KPI view/entry · 4253 monthly performance brief · 4983 CSV export date picker |
| 5769 | Weekly-KPI reminder (Sat 4pm → Sun midnight, America/Chicago) |
| 5845 | KPI due reminders — data-aware action-feed nags |
| 6132 | **Analytics workspace shell** (`workspace.html`) |
| 6243 | **Operations page shell** (`operations.html`) — sub-tab host |
| 7791 | `12. HUB DATA & LIVE DASHBOARDS` |
| 8041 | `13. CHARTS & LEADERBOARDS` |
| 8166 | `14. RECORDS MANAGER` |
| 8483 | `15. MONTHLY AWARDS` |
| 8738 | `16. QUICK MESSAGES` |
| 8925 | `16. GLOBAL AUTH OVERLAY` (number reused) |
| 9071 | `17. IDEA SUBMISSION MODAL` — the "SPEEKS Idea" form; posts to formsubmit.co, recipients from the `idea_submissions` list |

## Dashboards & goals (9,781 – 15,520)

| Line | Area |
|---|---|
| 9787 | Live dashboard (Shopify, refreshed each minute) · 9860 previous-day view · 10054 store-activity feed |
| 11990 | The buying half |
| 12365 | Against last month / last year |
| 13426 | `19. DISTRICT COMMAND CENTER` (master dashboards) |
| 13667 | `20. LISTING GOALS ENGINE` · 14904 Monday goals reminder · 14973 daily store reminder · 15143 DM data · 15179 DM audit-readiness widget |
| 14565 | Multi-store manager — dual-store listing goals |
| 15215 | `21. EMPLOYEE DASHBOARD WIDGETS` |

## B2B DEALS (15,524 – 23,230) → see [`b2b.md`](b2b.md)

The subject of the current feedback backlog. Summary index only here.

| Line | Area |
|---|---|
| 15524 | Module banner (`operations.html #ops-pane-b2b`) |
| 15546 | `B2B_STAGES` / stage map / board columns · 15567 `B2B_ACTIONS` |
| 15779 | Identity · 15838 scope + ownership · 15952 formatting · 16023 data · 16071 responsiveness |
| 16225 | SPEEKS Capture tool — distribution + version history |
| 16441 | Live bench intake (off unless `b2b-live-intake` is on) |
| 16771 | Live collaborative pricing (the realtime sync) |
| 16973 | Render controller · 17056 Needs You · 17123 Pipeline · 17200 Completed · 17331 Clients · 17923 **Overview (DM/CEO)** |
| 17414 | Outreach (the mini CRM) · 17508 stat tiles · 17663 CRM settings (CEO only) |
| 18269 | Pre-evaluations · 18326 view · 18390 editor · 18573 conversion |
| 18675 | Approval evidence · 18785 attaching |
| 19100 | Stage 1 pickup sign-off · 19199 stage 2 pricing location |
| 19251 | Line-item helpers · 19320 item shape helpers |
| 19508 | Signature capture · 19572 the phone's side |
| 19709 | Moving a deal between stores · 19800 reordering the sheet |
| 20505 | Pricing spreadsheet · 20611 Excel-style cell selection · 20910 detail sheet |
| 21060 | Stage 3 pricing · 21183 stage 4 quote · 21612 shared quote maths and wording |
| 22039 | Stage 5 listing location (CORP-priced only) · 22074 stage 6 listing |
| 22563 | Read-only view |
| 23233 | Feed reminder |

## Shopify matching & categories (23,300 – 25,420)

| Line | Area |
|---|---|
| 23312 | History tab section state |
| 23360 | Storefront a match sells from (`.myshopify.com` domains) |
| 23508 | Helpers · 23608 load & render · 24160 match panel · 24304 actions (optimistic) |
| 24566 | Realtime: matcher broadcasts when the match SET moves |
| 24579 | Shop-floor board greeting (split out of `applyRoleBasedUI`) |
| 24721 | `MULTISTORE_MANAGER_STORES` |
| 24995 | Init listeners |
| 25119 | Pinned tooltip state |

## Announcements, goals, projects (25,426 – 26,850)

| Line | Area |
|---|---|
| 25426 | Chart: render KPI · 25613 draw leaderboard |
| 25657 | Modal: manage announcements · 25873 banner · 25907 multi-store stacked goals · 25949 previous-months dropdown · 26104 edit modal |
| 26167 | District overview · 26182 storage helpers |
| 26200 | Company projects banner · 26254 edit modal · 26338 store initiatives · 26418 district views · 26474 sync from sheet |
| 26515 | Modal: manage alerts · 26654 manage hotkeys |

## Checklists, audits, claims (26,851 – 31,410)

| Line | Area |
|---|---|
| 26851 | DM: one store's full checklist |
| 27037 | DM scorecard submission · 27174 audit points (=165) · 27189 audit catalog · 27729 cached latest audit · 28201 refetch |
| 28492 | Which stores a user can file claims for |
| 28934 | Reminder-locks (a nudge, not a nag) |
| 29286 | Aging-claim red alert bubble · 29356 DM/CEO review reminders · 29538 claims aging across all stores |
| 29816 | Store comments |
| 30328 | `14.5 WEEKLY CHAMPIONS` (listers & buyers) |
| 30485 | Multi-store manager checklist caches · 30644 footer hiding · 31113 audit caches |
| 30859 | API actions (POST to Apps Script) · 30961 checklist nudge helpers · 31012 toggle & click-away |

## Roles, patch notes, feature access, search (31,417 – 37,150)

| Line | Area |
|---|---|
| 31417 | Role selection logic |
| 31582 | Patch notes · 31729 manage · 31854 editor · 31909 edit a version |
| 32054 | Store to box-order supplier email map |
| 32616 | Recycle requests |
| 33636 | The DM/CEO management tool |
| 33979 | Feature access — DB-driven show/hide for tools, hotbar, dashboards (`FEATURE_CATALOG`) |
| 35086 | Global search — every tool, tab, page, panel, hotbar sheet |
| 35601 | Variance: DM uploads the sub-10% line items per store per period |
| 36971 | **Buying margin — PARKED** (see :37005-37012; hidden until the POS report exists) |

## Preferred purchases, feed, misc (37,155 – 43,000)

| Line | Area |
|---|---|
| 37155 | Render · 37310 DM thresholds + generation · 37378 reminders |
| 37535 | Weekly DM hand-picked 30-day-plus POS items |
| 39210 | **Unified feed** (announcements + store notes + reminders/due dates) · 39741 progress mirrors · 39768 listing goals mirror · 39884 reminders & due aggregation |
| 40211 | Init · 40303 self-echo suppression |
| 41310 | Merged widget (was Listing Goals + Cleaning Checklist + Monthly Team Goals) |
| 41657 | DM stretch factor · 41723 DM efficiency view |
| 42170 | Store panel renderer (replaced five side-by-side cards) · 42192 number helpers · 42265 normalise one store · 42358 every check the panel makes · 42508 rail · 42529 pane sections · 42957 board |

## eBay, expenses, categories (43,004 – 47,220)

| Line | Area |
|---|---|
| 43004 | DM page board (was two stacked cards) |
| 43357 | Expense reports — one per person per month; mileage + line items |
| 44555 | Session feed · 44603 entry · 44787 render · 44812 standby banner |
| 45136 | Categories: filing the `other` pile · 45412 choosing a different shelf · 45611 the nag: listings waiting on a category · 45716 actions |
| 46626 | Custom select — a native `<select>` renders its popup in the OS, not the page |

---

## Backend

**63 edge functions** in `supabase/functions/`. Groups: B2B (`b2b-deals`,
`b2b-outreach`, `b2b-intake`, `b2b-capture-tool`), eBay (14 `ebay-*`), Shopify
(7 `shopify-*`), KPI/reporting (`kpi-manage`, `scorecard`, `weekly-report`,
`monthly-brief`, `daily-brief`, `usage-report`, `cash-report`, `summary-weekly`),
and the shared `notify` + `email-recipients` pair that most features route
outbound mail through.

**86 migrations** in `supabase/migrations/`. Numbers are duplicated across two
work streams (two each of `0004`–`0009`, `0044`–`0054`). **Max is `0066`; start
new work at `0067`.** Headers carry the design reasoning — read them.
