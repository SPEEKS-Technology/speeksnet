# Projects approval + Development tracker — plan

Drafted 2026-11-17 against `pre-release` @ `4582bf1`. Two releases:

- **Release A — Projects (small, ship first).** Approval and tracking for work
  that sits *next to* SPEEKSNET: Claude-built tools, extensions, scripts. Time
  sensitive: no project starts without Ethan's approval, and today there is
  nowhere to ask for it.
- **Release B — Development tracker (big).** Everything currently on GitHub
  Issues/Projects moves into SPEEKSNET: tickets, branches, releases, and the
  only path to production.

Release A builds the page that Release B adds a tab to, so A comes first.

---

## What this builds on (checked, not assumed)

| Piece | Where | Use |
|---|---|---|
| Per-user feature switches | `feature_overrides` table, `feature-access` fn, `FEATURE_CATALOG` (`speeks.js` ~44167), resolved user > role > default | "Dev" is a feature switched on per person, not a new role |
| PIN → person on the server | `users.select("name, role").eq("pin", pin)` in `expenses`, `daily-brief`, `email-recipients` | Who requested / approved / changed what. Better than `_b2bUser()` (sessionStorage) |
| Email alerts | `notify_queue` (0033, categories restored in 0175) | Category `requests` already exists — use kinds `project_request`, `project_decision`, `ticket_*`; no constraint change |
| Live refresh | `broadcastChange()` pattern in every write fn | Board updates without reload |
| Submit an Idea | modal `speeks.js` ~12516, `idea-submit` fn, `idea-attachments` bucket (0173) | Becomes ticket intake in Release B |
| Patch notes | `patch-notes` fn + in-app editor | Release builder writes into it |
| Branch protection on `main` | push restrictions ON with empty allow-list, `enforce_admins` on, required check `check-source-branch` | Add the GitHub App to the allow-list → only SPEEKSNET can ship |

GitHub today: 211 open + 64 closed issues, 272 PRs, 43 releases/tags, 14
milestones (one per update, "Main December Update" open), 5 remote branches,
3 labels (Bug/Fix, Feature Update, Minor Update). Repo is **public**.

---

## Release A — Projects

### Workflow

```
Requested ──approve──▶ In progress ──mark complete──▶ Completed ──decide──▶ Incorporate into SPEEKSNET
    │                       │                                       ├─▶ Keep standalone
    ├─request changes─▶ (back to requester, resubmits)              └─▶ Retire
    └─decline──▶ Declined                          (any time) ──▶ Parked
```

- Anyone signed in as a person can **request** a project.
- Only the approver (Ethan, DM) can approve, decline, request changes, mark
  complete, and record the outcome. Approval *is* the start: approved projects
  go straight to **In progress**.
- Owner can post progress updates on their own In progress project.
- "Incorporate into SPEEKSNET" is a recorded decision in A; in B it also
  creates Development tickets linked back to the project.

### Data — one migration (next free number at the time; `0181` today)

`projects`
- `id` (shown as `PRJ-12`), `title`, `description`, `involved` jsonb
  `[{id, name}]` — three fields only (Nick, 2026-11-17: "as simple as Project
  Title, Project Description, and Who's involved"). `involved` holds real
  `users.id` values picked from the roster, not typed names; `requested_by_id`
  likewise. Anyone in `involved` posts updates; whoever asked, or the DM, can
  edit while it's open. Applied as migration **0186** (0185 was taken in the DB).
- `status` check in (`requested`, `changes_requested`, `in_progress`,
  `completed`, `declined`, `parked`)
- `outcome` check in (`incorporate`, `standalone`, `retire`) nullable
- `requested_by` (name resolved server-side from PIN),
  `decided_by`, `decided_at`, `decision_note`, `completed_at`, timestamps

`project_events` — append-only history: `project_id`, `kind` (created, edited,
approved, declined, changes_requested, update, completed, outcome, parked),
`actor`, `note`, `created_at`. The detail page's timeline reads this.

RLS on both, written only through the edge function (service role), matching
every other tool.

### Edge function `projects`

- `GET` — every project for the DM, CEO and MOCD (always, by role — "not a
  switch", Nick 2026-11-17) and for anyone covering approvals; for everyone
  else only the projects they asked for or are involved in. Filtered
  server-side, so other people's projects never reach the browser.
- `POST` with `x-user-pin`, actions: `create`, `edit` (requester while
  requested/changes_requested), `update` (anyone involved, or the approver, while in progress),
  `approve`, `decline`, `request_changes`, `complete`, `set_outcome`, `park`.
- Approver check is **server-side**: resolve PIN → user → role, then apply the
  same user > role > default resolution against `feature_overrides` for
  `projects-approve`. (The browser-side feature check only hides buttons.)
- Each write: insert `project_events`, `broadcastChange('projects')`,
  `queueNotification` — new request → approver; decision → requester.

### Front end

- A **Projects tab in Workspace** (`workspace.html#projects`) — not its own page
  (Nick: "in workspace for now is fine"). Built from Workspace's own pieces so
  it matches the site: `.ws-head` card, a Variance-Replies-style segmented
  status filter (Awaiting approval · In progress · Completed · Closed), and a
  `.cb-table` list. Row → detail popup (the site's tool-popup style).
- "Request a project" form: title, description, and who's involved — a
  type-to-search picker over the roster (no PINs sent), stored as `users.id`.
- Detail popup: description, who's involved, history from `project_events`,
  progress updates, approver buttons.
- "Waiting on you" count on the Projects tab (the B2B tab's pip).
- `FEATURE_CATALOG`: `nav-projects`, `projects-request`, `projects-approve`
  (`district-manager` default — delegable in Feature Access if Ethan is out).
- Supporting change: the `auth` function keeps each person's `users.id` across
  the Manage Users save (matched by PIN) so stored ids stay valid.

### Also in A

- A Processes & Policies entry (docs.html CMS, not code): "Projects need DM
  approval before work starts," linking to the page.
- Leave Company Initiatives alone for now — it's the CEO's priorities list, a
  different thing. Revisit after B.
- Checks: `scripts/projects-check.js` (renderers, status transitions,
  approver-only buttons) + layout check at 390/820/1440.
- CLAUDE.md: cache-buster pages list (it said five; six is right) and the
  Identity section (users.id is now stable).

### Ship A

Bump `APP_VERSION` (it currently reads 3.11.0 though v3.12.0 is tagged — fix
that in the same commit), cache-busters on all pages, apply migration, deploy
`projects`, patch note.

---

## Release B — Development tracker

### B1. Dev access and foundations

- Feature key **`dev-tracker`**, default off for every role, switched on per
  person in Feature Access. Same server-side resolution as `projects-approve`
  in every dev endpoint.
- Tables: `tickets`, `ticket_comments`, `ticket_events`, `ticket_types`,
  `ticket_areas`, `releases`, `ticket_links` (commit / branch / PR refs),
  `github_branches` (cache), `github_people` (login → SPEEKSNET name:
  `Eckushnir` → Ethan, `back707` → Nick), `github_sync_log`.
- **Numbering:** imported issues keep their number (`#573` → `SN-573`), so
  every old commit/PR reference still resolves. New tickets start at
  `SN-1000` — GitHub shares one sequence between issues and PRs, so starting
  above it avoids an `SN-` number that is also a PR number.

### B2. Ticket types (table-driven, add more without code)

| Who can pick it | Type | From GitHub label |
|---|---|---|
| Everyone | Bug fix | Bug/Fix |
| Everyone | Suggestion | Feature Update |
| Everyone | B2B | — |
| Everyone | Question / other | — |
| Devs only | Improvement | Minor Update |
| Devs only | Task / chore | — |

**Open decision:** "B2B" is an *area*, not a kind of work — a broken B2B quote
is both B2B and a bug. Recommended: keep the type list above minus B2B, and add
an **Area** field (B2B, Claims, eBay & listings, KPIs & stats, QuickPortal,
Operations, Callbacks, Other). Both lists live in tables, so this is a
data choice, not a rebuild.

Fields: title, description, type, area, priority, status, assignee,
reporter, stores, release, due, attachments, linked project (from A).

Statuses: Triage → Backlog → In progress → In review → On pre-release → Done
(+ Won't do). The last three move automatically from GitHub (B5).

### B3. Import from GitHub (one-off, dry run first)

- 275 issues with body, comments, labels → type, assignees → people,
  open/closed → status, milestone → release.
- 14 milestones + 43 releases → `releases` with their notes.
- Verify counts in SPEEKSNET, then: comment "Moved to SN-573 on SPEEKSNET" on
  each open issue, close them, turn Issues off. That last part is a GitHub
  setting an org admin changes by hand.

### B4. Submit an Idea → Submit a ticket

- Same button and popup, reworked: type, area, description, attachment.
- Creates a ticket in **Triage** (attachment goes to the ticket); the email to
  the `idea_submissions` list still goes out, now with a link to the ticket.
- A "This is a project I want to build" choice routes to the Projects request
  form instead.
- Submitters see **My tickets** with status, so a store hears back.
- Devs create tickets directly from the Development page with the dev-only types.

### B5. GitHub sync (read)

- A **GitHub App** installed on `speeksnet` only. Read: contents, pull requests,
  metadata. Its key lives in Supabase secrets.
- `github-webhook` edge function, signature verified: `push`, `pull_request`,
  `create`/`delete` (branches), `release`. Nightly reconcile catches missed
  deliveries.
- Linking: a branch name or commit/PR text containing `SN-123` attaches to the
  ticket. PR opened → In review; merged to `pre-release` → On pre-release;
  shipped in a release → Done.
- Changed-file rules, shown on the ticket and in the release checklist:
  - new `supabase/migrations/*` file → "migration to apply"; number already
    used → flagged before merge
  - `speeks.js` / `styles.css` changed without cache-buster bumps → flagged
  - `supabase/functions/*` changed → "function to deploy"

### B6. Branches panel

- Every remote branch on the Development page: linked ticket, ahead/behind
  `pre-release`, last commit and who, PR state, stale flag.
- Naming convention: `fix/sn-1012-short-slug`, `feat/…`, `chore/…`,
  `release/vX.Y.Z`. **Start work** on a ticket creates the branch from
  `pre-release` with the right name (GitHub write).
- Branches with no ticket (e.g. `Main-December-Update-2---Ethan` today) are
  flagged with "link to ticket" or "mark as release branch". Merged-and-stale
  branches get a delete button (confirm first).

### B7. Release builder

1. Pick version (suggests next from latest tag), tickets that are On
   pre-release; anything unfinished rolls to the next patch.
2. Checklist: everything merged to `pre-release`; `APP_VERSION` and every
   page's cache-buster updated; migrations from the release applied; changed
   functions deployed.
3. Patch notes drafted from ticket titles (rewrite-for-staff optional), edited
   in place.
4. **Publish** (DM / dev with `release-publish` feature, PIN re-entered):
   version-bump commit on `pre-release` → PR `pre-release` → `main` → App
   merges → tag → GitHub release → in-app patch note → tickets Done → managers
   emailed.

### B8. Lock production

- Add the App to `main`'s push allow-list (already enabled, currently empty).
  Keep `enforce_admins`. From then on the release builder is the only way onto
  `main`, and GitHub Pages deploys from `main`.
- Do this **after** one Publish has worked end-to-end.
- Break-glass: an org owner can still edit the protection rule. Write that
  down in the runbook rather than pretend it doesn't exist.
- Claude Code sessions keep working on branches and PRs into `pre-release`;
  they can no longer reach `main`.

### B9. Later

- `speeks-mcp` ticket tools for Claude (read first, then comment/status), every
  AI action marked in the ticket history.
- Projects → "Incorporate" creates linked Development tickets.

---

## Gaps and risks to decide on

1. **The lock covers the front end only.** Edge functions and migrations
   deploy straight to Supabase (MCP / CLI), not through GitHub. Options:
   release-builder checklist records them (B7, cheap), or a GitHub Action
   deploys functions on merge to `main` and personal Supabase tokens are
   pulled (real enforcement, more work).
2. **Public repo.** The shared edge-function secret in the source is readable
   by anyone. Nothing that writes to GitHub may accept it — PIN + server-side
   feature check only, every write logged. PINs are short, so Publish also
   needs attempt limiting.
3. **Identity is still a name.** Approvals and tickets resolve the name from
   the PIN on the server, which beats sessionStorage, but a rename still
   orphans history.
4. **Release A version number.** v3.12.1, or ride into the December update?

## Order of work

A (one PR off `pre-release`) → B1+B2 → B3 import → B4 intake → B5 sync →
B6 branches → B7 release builder → B8 lock → B9.
