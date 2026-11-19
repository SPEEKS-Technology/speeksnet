# HANDOFF — Development tracker (the update after Projects)

Written 2026-11-17, at `pre-release` @ `e60fe21` (Projects merged, PR #577).
Read this whole file before starting. Companion: `projects-and-dev-tracker.md`
(the original two-release plan; Release A there is done — this file is
Release B, with everything decided since).

---

## 1. The goal, in Nick's words

> "A fully ported over ticket system. All internal on speeksnet. So we import
> everything from github and then make our own ticket system for development
> around anything speeksnet related. Lining up releases with updates and bug
> fixes to the website all in speeksnet. Pulls any data of commits and
> releases … from github as needed and pushes releases and tags from our
> speeksnet build builder."

> "We can put permissions on the github to make it so only [SPEEKSNET] can
> push updates to prod. This will let us put more quality control on updates
> instead of freeballing claude doing it for us."

In short: GitHub stays where the **code** lives. Everything about the
**work** — tickets, branches-to-tickets, releases, patch notes, shipping —
moves into SPEEKSNET, and shipping to production happens only from there.

---

## 2. Decisions already made (don't relitigate)

| # | Decision | Source |
|---|---|---|
| D1 | Full port: **import all GitHub issues**, then stop using GitHub Issues/Projects. | Nick |
| D2 | **Dev access is a per-person Feature Access switch, not a role.** | "This honestly can just be enabled as feature access for specific users instead of a secondary role." |
| D3 | **Submit an Idea becomes ticket intake** for developers. | "The submit idea system should be reworked to forming tickets for developers." |
| D4 | Ticket types align with the work — **B2B, bug fix, suggestion, etc.** Same list is what users submit and what devs create (devs may get extra types). | Nick |
| D5 | **Branches synced with GitHub and shown on the dev page**; branch names consistent with the work being done. | "I want to make the branches that we have on github to be consistent with what work is being done … have a place on the developer page." |
| D6 | **Read from GitHub as needed** (commits, PRs, branches, releases). | Nick |
| D7 | **Write to GitHub only for mechanical release steps**: tags, GitHub releases, the pre-release→main merge, the version-bump commit, creating ticket branches. No two-way issue sync, no code editing, no merging feature PRs from SPEEKSNET. | Agreed in planning |
| D8 | **Lock `main`** so only SPEEKSNET's GitHub App can push/merge to it. | Nick |
| D9 | New UI must **look like the rest of the site** (Workspace's `.ws-head` card, segmented filters, `.cb-table` lists, the site's tool popups and buttons). No bespoke chrome. | Nick, on Projects: "make all of the UI consistent with how the UI looks on the rest of the website" |
| D10 | People are **real users** picked from the roster and stored as `users.id` — never typed names. | Nick, on Projects |

---

## 3. Open decisions — ask Nick before building the affected phase

Q1, Q2 and Q5 were answered in Phase 0 (2026-11-18) — see §3a. The rest are
still open.

| # | Question | Recommendation | Blocks |
|---|---|---|---|
| Q1 | ~~Is **B2B a ticket type or an area**?~~ **Answered → §3a.** | Type (Bug / Suggestion / Improvement / Task) **plus** an Area field (B2B, Claims, eBay & listings, KPIs, QuickPortal, Operations, Callbacks, Other). Both table-driven. | Phase 1 |
| Q2 | ~~**Where does the dev tracker live?**~~ **Answered → §3a** (not the Workspace tab recommended here). | A Workspace tab ("Development") gated by the dev switch, matching Projects. Revisit a page of its own if it outgrows a tab. | Phase 3 |
| Q3 | **Who can Publish** (ship to prod)? | DM + named devs via a separate `dev-release-publish` switch, PIN re-entered at publish. | Phase 6 |
| Q4 | **Edge functions & migrations bypass GitHub** (deployed straight to Supabase). Lock those too? | Phase 6 just records them on the ship checklist; a later phase can deploy functions from a GitHub Action on merge to `main`. | Phase 6/7 |
| Q5 | ~~Ticket numbering.~~ **Answered → §3a.** | Imported issues keep their GitHub number (`#573` → `SN-573`) so old commit/PR references resolve; new tickets start at **SN-1000** (GitHub shares one sequence between issues and PRs). | Phase 1 |
| Q6 | What happens to closed GitHub issues after import, and when does Issues get switched off? | Import → verify counts in SPEEKSNET → comment "Moved to SN-n" on open issues and close them → an org admin turns Issues off. | Phase 2 |
| Q7 | Should completed **Projects** with outcome "Fold into SPEEKSNET" spawn dev tickets automatically? | Yes, a "Create dev ticket" button on the completed project, linking both ways. | Phase 3 (nice-to-have) |

---

## 3a. Phase 0 answers (Nick, 2026-11-18) — decided, don't relitigate

| # | Answer |
|---|---|
| Q1 | **Type + Area**, as recommended. Types: Bug / Suggestion / Improvement / Task (devs may get extra types). Areas: B2B, Claims, eBay & listings, KPIs, QuickPortal, Operations, Callbacks, Other. Both lists live in tables (`dev_ticket_types`, `dev_ticket_areas`), not code. |
| Q2 | **Not a Workspace tab.** In Nick's words: *"this will only be available to myself and Ethan the DM, and it will be pretty important … put it in a pretty prominent spot. Maybe on the quick tools at the top to the right of settings? And then a slightly green hue to it."* So: a header **quick-tool button** (`.action-btn`) placed **directly right of Settings** (`#notifySettingsBtn`) in every page's header, with a subtle green tint so it reads as different from the neutral tools, gated `data-feature="dev-tracker"`, `data-mobile="hide"` like Settings. **Where it opens** wasn't specified; default plan is a full-screen page of its own, **`dev.html`**, the way B2B moved to `b2b.html` (a whole ticket tracker is too much for a popup). That makes the cache-buster **seven** pages — update CLAUDE.md's list when it lands. Confirm with Nick at the start of Phase 3 if a popup was meant instead. |
| Q5 | **Keep GitHub numbers, new tickets from SN-1000**, as recommended. Imported issue `#573` → `SN-573`; a sequence starting at 1000 for everything new. |
| D2 | Confirmed: dev access is **only Nick and Ethan (DM)** for now. `dev-tracker` defaults to **off for every role** (including DM, so it's a per-person grant, not "the DM role"), switched on for those two people in Feature Access. |

**GitHub people → `users.id`** (seed `github_people` from this in Phase 1; verified against `users` 2026-11-18):

| GitHub login | Person | `users.id` |
|---|---|---|
| `Eckushnir` | Ethan Kushnir (District Manager, CORP) | `523bae7a-5308-4294-ba7e-540a081e67b9` |
| `back707` | Nick Hettinger (Manager, OVL) | `01b159e2-bbbd-4151-b650-6c64780e782d` |

⚠️ There is also an **Ethan Frye** (Assistant Manager, LEE). Match on the id above, never on the first name "Ethan".

**Migration number for Phase 1:** this said `0187` — and was wrong within hours: another session's `feat/projects-completion-signoff` (PR #581) took `0187_projects_signoff.sql` the same afternoon. Phase 1 is **`0188_dev_tracker`**. Re-check `list_migrations` **and every remote branch** (`git ls-tree` each) immediately before applying, not just when writing.

**GitHub App permissions — one change from Phase 0 below:** the import (Phase 2) reads issues, comments and milestones, so the App needs **Issues: read** as well as Contents / Pull requests / Metadata read. The original list missed it.

---

## 4. Where things stand (verified 2026-11-17)

### GitHub (`SPEEKS-Technology/speeksnet`, **public** repo)
- 211 open + 64 closed issues; 273 PRs; 43 releases/tags (latest `v3.12.0`); 14 milestones (one per update; "Main December Update" open); 3 labels: `Bug/Fix`, `Feature Update`, `Minor Update`. Assignees on issues: `Eckushnir` (Ethan) ~247, `back707` (Nick) ~11.
- Branches today: `main`, `pre-release`, `Main-December-Update-2---Ethan`, `feat/header-icon-tabs`, `feat/projects-approval` (merged), `fix/b2b-quote-mark-sent`.
- **`main` protection:** push restrictions ON with an **empty** allow-list, `enforce_admins` on, required check `check-source-branch` (`.github/workflows/main.yml`: main only accepts merges from `pre-release`). Locking main (D8) = add the GitHub App to that allow-list.
- **`pre-release` protection:** PRs required, 0 approvals.
- GitHub Pages serves `main` → speeksnet.com.
- The local `gh` token lacks `read:project`, so the old GitHub Projects board was never read. If its columns/fields matter to the import, re-auth with `gh auth refresh -s read:project`.

### SPEEKSNET
- `APP_VERSION` in `speeks.js` reads **3.11.0** while the latest tag is **v3.12.0** — exactly the drift the release builder (Phase 6) should make impossible. Fix it in the December release regardless.
- Cache-buster is on **six** pages (`index`, `operations`, `b2b`, `workspace`, `stats`, `docs`), currently `20261117p`.
- Submit an Idea: modal at `speeks.js` ~12520 (`IDEA_SUBMIT_URL`, `submitIdea()`), `idea-submit` edge function, `idea-attachments` bucket (0173). Categories today: New Feature / Process Improvement / Bug Fix / Issue / Other. Emails the `idea_submissions` recipient list.
- Patch notes: `patch-notes` edge function + in-app editor; `notify` emails them.
- Edge functions: 107 directories under `supabase/functions/` (CLAUDE.md's "63" is stale).

### Supabase
- Migration max in the **database** is `0186_projects`. The repo trap is real: on 2026-11-17 the DB had a `0185` no branch knew about. **Always check `list_migrations` and every open branch** before numbering.
- No Supabase CLI and no Python on Nick's machine. Deploys go through the Supabase MCP (`deploy_edge_function`, file content passed inline). `notify` is ~118 KB — plan deploys of it deliberately.
- `notify`'s Projects label/toggle changes are committed but **not deployed** (cosmetic). Deploy with the December release.

---

## 5. Patterns to copy from Projects (Release A) — they're tested

Read `speeks.js` "24b. MODULE: PROJECTS", `supabase/functions/projects/index.ts`, and migration `0186_projects.sql` first. Reuse, don't reinvent:

1. **Identity:** resolve the person from `x-user-pin` on the server (`users` select `id, name, role, store`); store **`users.id`**, plus the name at the time for display. `users.id` is stable now — `auth` carries it across the Manage Users delete-and-reinsert save, matched by PIN. **No FK to users** (the delete-all save would break or cascade).
2. **Permissions:** Feature Access keys resolved **server-side** with the same user > role > default rule as the browser (`permsFor()` in `projects`). Keep defaults in both `FEATURE_CATALOG` and the function's `DEFAULTS`. Fixed rules that must not be switchable go in code (cf. `SEES_ALL_ROLES`).
3. **Roster picker:** the function returns `people: [{id,name,store,role}]` (no PINs, no `role='store'` board accounts); the browser picker is `prjPeople*` (type-to-filter, chips, Enter/Backspace, in-flow list). Lift it into a shared helper rather than copying it a second time.
4. **Emails:** insert into `notify_queue` with `category`, `kind`, `audience_roles` and **`audience_feature`** (so a delegated permission routes the mail), link to `workspace.html#tab`. Register new kinds in `notify`'s `SUBS` and `KIND_LABEL`.
5. **Realtime:** `broadcastChange('<tool>')` after every write; add the tool to `_RT_TOOL_CHECKS` in `speeks.js`.
6. **Workspace tab wiring:** tab button with role classes + `data-feature`; pane `card ws-tool-panel ws-panel`; popups **outside** the pane but inside `.main-content`; `switchWorkspaceTab` case; `initWorkspace` hash list; `_SECTION_TABS['workspace.html']`; Jump entry (`kind: 'tab'`).
7. **Writes race-safely:** status transitions update `... .eq('status', from)` and report a clash rather than overwrite.
8. **Checks:** three suites per feature — behaviour, layout (run plain **and** with `-WindowSize 1440,900`), and `-Html workspace.html` markup. A `-Html` check that touches `sessionStorage` must restore it.
9. **Test sessions:** GETs work for test accounts, POSTs are refused by the fetch guard — so live reads are safe to test with PINs 0000–0008.

---

## 6. The build, phase by phase

Each phase is shippable on its own and gets its own PR into `pre-release`.

### Phase 0 — Prerequisites (before writing code)
- [x] Get answers to **Q1, Q2, Q5** (§3) — 2026-11-18, recorded in §3a.
- [x] **Create the GitHub App** — done 2026-11-18: slug **`speeksnet`**, App ID `5823517`, installation `183468117` on the org (selected repositories), permissions exactly Contents / Issues / Pull requests / Metadata **read**, webhook off. Originally specced as: "SPEEKSNET" on the `SPEEKS-Technology` org, installed on `speeksnet` only. Permissions: Contents **read** (write later, Phase 5/6), Pull requests read (write later), **Issues read** (for the Phase 2 import), Metadata read. **Webhook off for now** — `github-webhook` doesn't exist until Phase 4; turn it on then, with its URL and a webhook secret.
- [x] Store the App's secrets — done 2026-11-18; `secrets list` digests of the App ID and installation ID match the values above. **The private key is unverified until something signs with it** — the first function that mints an installation token (the Phase 2 import's dry run, or a tiny probe in Phase 1) proves it. A 401 there means the `.pem` was pasted wrong (missing header/footer lines or mangled newlines). As specced: store the App's secrets as **Supabase function secrets** (never in the repo — it's public): `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` (the whole `.pem`, header lines included). `GITHUB_WEBHOOK_SECRET` follows in Phase 4. Nick enters the private key himself in the Supabase dashboard — it never goes through chat or a Claude session.
- [x] Decide the people mapping: `Eckushnir` → Ethan Kushnir, `back707` → Nick — ids in §3a.

### Phase 1 — Data model + dev access
> **Built 2026-11-18 on `feat/dev-tracker`** (all phases of this update stay on that one branch — Nick, 2026-11-18). Migration `0188_dev_tracker.sql`, function `supabase/functions/dev-tickets`, catalog entries next to `nav-settings` in `FEATURE_CATALOG`, checks in `scripts/dev-tracker-check.js`. Decisions made while building, beyond the draft below:
> - Dev-created tickets start in **Backlog** (a dev has already triaged it); only Phase 3's intake lands in **Triage**.
> - Tickets can be **assigned only to people who hold `dev-tracker`** — the GET returns them as `devs`.
> - **Won't do needs a reason** (the reporter reads it); any other status can move to any other by hand until Phase 4 automates some.
> - Only your own SPEEKSNET-written comments are editable; imported GitHub comments are the record.
> - `edit` takes only the fields sent and is race-safe on `updated_at`; `status` is race-safe on the status it moved from.
> - Types get a `dev_only` flag for later; none of the four seeded types uses it. `dev-release-publish` is granted to nobody until Q3.
> - The two `dev-tracker` grants (Nick, Ethan) are seeded by the migration as ordinary `feature_overrides` user rows — visible and revocable in Feature Access.
- Migration (next free number — check!): `dev_tickets`, `dev_ticket_comments`, `dev_ticket_events` (append-only history), `dev_ticket_types`, `dev_ticket_areas` (if Q1 = type+area), `dev_releases`, `dev_ticket_links` (commit / branch / PR refs), `github_branches` (cache), `github_people` (login → `users.id`), `github_sync_log`.
- `dev_tickets` columns (draft): `id` (= SN number), `title`, `description`, `type`, `area`, `priority`, `status` (`triage`, `backlog`, `in_progress`, `in_review`, `on_prerelease`, `done`, `wont_do`), `assignee_id` (users.id), `reporter_id` (users.id) + names at the time, `stores` text[], `release_id`, `due`, `source` (`github_import` / `idea` / `dev`), `github_number`, `project_id` (link to Projects), timestamps.
- Numbering per Q5: imported rows take their GitHub number; a sequence starting at 1000 for new ones.
- Feature Access keys: **`dev-tracker`** (see/use the dev tab; default off for every role, switched on per person — D2), **`dev-release-publish`** (Q3).
- Edge function `dev-tickets` (GET list + roster + people map; POST create/edit/comment/status/assign), on the Projects pattern.
- **Done when:** a dev-switched user can create/edit/comment on tickets via the function; non-dev users get 403; checks pass.

### Phase 2 — Import from GitHub (one-off, dry run first)
> **Built 2026-11-18 on `feat/dev-tracker`:** edge function `supabase/functions/github-import` (deployed). `GET` + a dev's PIN is the dry run (writes only a `github_sync_log` row); `POST {apply: true, open_in_closed: 'done'|'backlog'}` with a **real** dev PIN imports. Re-runnable — existing tickets are skipped, never overwritten — so run it once more just before Issues is switched off to catch late issues. The first dry run was also the first proof the App's private key works. Found and decided on the dry run (Nick, 2026-11-18):
> - **190 of the 211 open issues sit in milestones that already closed** — the update shipped and the issues were never closed. Nick: import them as **Done**, each with a history note saying so (`open_in_closed: 'done'`). Leaves 21 genuinely open in Backlog; 248 done, 6 won't do.
> - **Releases imported as-is:** 14 milestones + 43 tags, paired where a tag's name carries the milestone's title (4 pairs: Launch, Patch 1, Season 1 Reloaded, Main October — a looser match paired two wrongly and was tightened) → 53 `dev_releases` rows of history. Tickets attach to the milestone rows. Phase 6 creates releases properly from then on.
> - GitHub had **no issue comments** at all; both logins map (no unmapped people); 10 unlabelled issues → Task; Area left blank on every import.
> - The stored key's header didn't say `RSA` though the key is PKCS#1 — `appToken()` reads the format from the DER instead. Reuse it (Phase 4–6 need the same token).
> - **Imported 2026-11-19 (Nick ran it).** The first run wrote all 275 tickets and 53 releases — counts, types, statuses, assignees and releases verified against GitHub — then failed on the history: a bulk insert sends one column list, so rows without a `created_at` key got NULL rather than the default. Fixed (every row dated) and the function now backfills history for any imported ticket that has none, so the fix is the same command run again. **Trap for every later bulk insert here: give every row the same keys.** Second run (15:45) wrote the history: 275 created + 254 status (190 of them "still open on GitHub, but its update had shipped") + 275 imported, every ticket covered, nothing duplicated.
> - **Not done yet — the GitHub close-out (Q6).** Recommended order: wait until Phase 3's page is live (until then the tracker has no screen, and GitHub is still where Ethan sees his work), re-run the import to catch issues raised meanwhile, then comment "Moved to SN-n" on and close the open issues, then an org admin switches Issues off. Ask before each — they're outward-facing, and the App is read-only so they'd run under a person's token.
- Edge function `github-import` (or a one-off script run through the MCP), **dry-run mode by default** that reports counts and mapping without writing.
- Import: all 275 issues (body, comments, state, labels → type, assignees → people via `github_people`, milestone → release), 14 milestones + 43 releases → `dev_releases` (with notes).
- Label mapping: `Bug/Fix` → Bug, `Feature Update` → Suggestion/Feature, `Minor Update` → Improvement (adjust to Q1's list).
- Verify counts against GitHub. Then (Q6) comment + close open issues on GitHub, and an org admin turns Issues off — **ask before doing either; they're outward-facing.**
- **Done when:** every issue is a ticket with history, counts match, GitHub issues point at their `SN-n`.

### Phase 3 — Intake + the Development tab
- **Submit an Idea → Submit a ticket** (D3): same button and popup, fields reworked to type (+ area), description, attachment; creates a ticket in **Triage**; the email to the `idea_submissions` list still goes out with a link to the ticket. A "This is a project I want to build" option routes to the Projects request form instead. Submitters see their own tickets' status ("My tickets").
- **Development page** (Q2 → §3a: a green-tinted header quick-tool button right of Settings, opening `dev.html`; seven cache-buster pages from then on): Workspace look (D9) — `.ws-head`, segmented status filter (Triage · Backlog · In progress · In review · On pre-release · Done), `.cb-table` list, ticket popup with history, comments, linked code, and dev actions. Triage inbox for new submissions. "My tickets" filter.
- Devs create tickets directly, with dev-only types.
- **Done when:** a store manager submits an idea and it appears in Triage for a dev; a dev moves it through statuses by hand; checks (3 suites) pass.

### Phase 4 — GitHub sync (read)
- Edge function `github-webhook`: verify the signature; handle `push`, `pull_request`, `create`/`delete` (branches), `release`. Nightly reconcile pull to catch missed deliveries (`github_sync_log`).
- Linking: `SN-123` in a branch name, commit message or PR title/body attaches to the ticket.
- Auto-status: PR opened → **In review**; merged to `pre-release` → **On pre-release**; shipped in a release → **Done**.
- Changed-file rules, shown on the ticket and later on the release checklist:
  - new `supabase/migrations/*` → "migration to apply"; **number already used in the DB or another branch → flag before merge**
  - `speeks.js` / `styles.css` changed but the cache-buster didn't → flag
  - `supabase/functions/*` changed → "function to deploy"
- **Done when:** opening and merging a real PR moves its ticket with no human touching the status.

### Phase 5 — Branches panel (D5)
- Every remote branch on the Development tab: linked ticket, ahead/behind `pre-release`, last commit and who, PR state, stale flag (merged and untouched 14+ days).
- **Naming convention:** `fix/sn-1012-short-slug`, `feat/sn-…`, `chore/sn-…`, and `release/vX.Y.Z`. A **Start work** button on a ticket creates the branch from `pre-release` with the right name (first GitHub *write* — needs Contents write).
- Branches with no ticket (e.g. `Main-December-Update-2---Ethan` today) are flagged: link to a ticket, or mark as a release branch. Merged-and-stale branches get a delete button (confirm first).
- **Done when:** every branch on GitHub shows on the panel with its ticket or a flag; Start work creates a correctly named branch.

### Phase 6 — Release builder
1. Pick the version (suggest next from the latest tag) and the tickets that are On pre-release; anything unfinished rolls to the next patch.
2. **Ship checklist:** everything merged to `pre-release`; `APP_VERSION` and all six cache-busters updated; migrations in the release applied (compare files vs `list_migrations`); changed functions deployed (Q4).
3. **Patch notes** drafted from ticket titles, edited in place, saved to the existing patch-notes table.
4. **Publish** (holders of `dev-release-publish`, PIN re-entered): version-bump commit on `pre-release` → PR `pre-release` → `main` → App merges → tag → GitHub release → in-app patch note → tickets Done → managers emailed. Every write logged with who pressed it.
- **Done when:** one real release goes out end to end from SPEEKSNET.

### Phase 7 — Lock production (D8)
- Add the GitHub App to `main`'s push allow-list. Keep `enforce_admins`. From then on the release builder is the only way onto `main`.
- Only after Phase 6 has worked end to end once.
- Write down the break-glass (an org owner can still edit the protection rule) in a runbook rather than pretending it doesn't exist.
- Claude Code sessions keep working on branches and PRs into `pre-release`; they can no longer reach `main`.

### Phase 8 — Later
- `speeks-mcp` ticket tools for Claude (read first, then comment/status), every AI action marked in history.
- Deploy edge functions from a GitHub Action on merge to `main` (closes Q4 properly).

---

## 7. Risks and traps

1. **Public repo.** The shared edge-function secret in the source is readable by anyone. Nothing that writes to GitHub may accept it — PIN + server-side Feature Access check only, every write logged, attempt-limit the Publish PIN.
2. **Migration numbers.** See §4 — check the database, not the checkout.
3. **Supabase bypasses GitHub.** Locking `main` doesn't stop a function deploy or a migration (Q4).
4. **`notify` is huge** (~118 KB) to deploy inline via the MCP; batch its changes.
5. **The Manage Users save is a full replace.** Any new column on `users` must be preserved in `auth` (see its header) — and ids now are; don't undo that.
6. **Workspace is hidden on phones** (every Workspace tab is `data-mobile="hide"`). An email link to `workspace.html#tab` still opens the pane on a phone, but there's no way to navigate there. Decide per feature whether that's acceptable.
7. **Cache-buster conflicts** are the usual merge pain between parallel update branches — resolve by taking a value newer than both.

---

## 8. Before the December update ships (Projects loose ends)

- [ ] **Real end-to-end test of Projects** — only reads have been exercised live. Run `speeksnet-node` from `.claude/launch.json` (local server; Python isn't installed), sign in with a real PIN on `localhost:8080`, submit a "Test — delete me" project, have the DM approve / post update / complete, confirm both emails arrive, then delete the test rows (`projects` + `project_events`).
- [ ] Merging `Main-December-Update-2---Ethan` with `pre-release` conflicts **only** on the six pages' cache-buster lines (checked by trial merge) — take a value newer than both.
- [ ] Bump `APP_VERSION` (3.11.0 → the December version) and write the patch note (include Projects).
- [ ] Deploy `notify` (Projects email labels / Settings toggles).
- [ ] **MOCD has no email alerts set up**, so they won't get Projects decision emails until they turn them on (Settings cog → Notifications).
- [ ] Add the policy "Projects need DM approval before work starts" to Processes & Policies.
- [ ] After the next real Manage Users save, confirm `users.id` values didn't change (the `auth` change is live but hasn't seen a real save yet).
- [ ] Optional: send the one-pager `docs/handouts/SPEEKSNET-Projects-How-It-Works.pdf` to Ethan.
