# Branches, merges and tickets — how SPEEKSNET development works

Read this before creating a branch, opening a PR or merging anything. It applies
to people and to Claude sessions equally — both developers (Nick and Ethan) do
most of their branching and merging through Claude, so these rules are written
for Claude to follow.

The tickets, branches and releases live in the **Development suite**
(`speeksnet.com/dev.html`). GitHub holds the code; the suite holds the work.

---

## The pipeline

```
Backlog  →  a branch  →  pre-release  →  live (main)
(tickets)   (building)   (the next update)  (speeksnet.com)
```

- **Backlog** — every ticket nobody is building yet.
- **A branch** — work in progress. A branch carries one or more tickets. Each
  branch is a column in the suite.
- **`pre-release` is the next update.** It is not a testing area that things
  pass through on their way somewhere else: **whatever is on `pre-release`
  ships in the next update**, all of it. Merging into `pre-release` is the
  decision to ship.
- **Live** — `main`, which GitHub Pages serves as speeksnet.com. Only the
  suite's **Go live** button puts anything there.

The next update's size is set in the suite: **Minor** (`x.y.Z`), **Major**
(`x.Y.0`) or **Overhaul** (`X.0.0`). Major and Overhaul need a title. Patch
notes are written automatically from the titles of the tickets that merged.

---

## Rules

### 1. Work starts from a ticket
- Before starting work, find the ticket(s) it is for (`dev_board` /
  `search_tickets` on the connector). If there isn't one, create it
  (`create_ticket`) and tell the user its number.
- **Ticket titles become the patch notes, word for word.** Write them for a
  store manager reading "what's new", not for a developer: *"Expense Tool
  Export Button"*, not *"add csv handler to exp module"*.

### 2. Creating a branch
- **Always from `pre-release`.** Never from `main`, never from another feature
  branch.
- **Name:** `feat/<what-it-does>`, `fix/<what-it-fixes>` or `chore/<what>` —
  lower case, hyphens. Bug work is `fix/`, new features and improvements are
  `feat/`, everything behind the scenes is `chore/`. One branch can carry
  several tickets, so the name describes the work, not a ticket number.
- **Create it through the connector** — `start_branch` with the ticket ids. The
  suite creates it on GitHub from `pre-release` and puts the tickets on it in
  one step.
- **If the connector isn't available:** `git switch -c feat/x origin/pre-release`,
  push it, and tell the user the branch needs its tickets added in the suite
  (drag them onto its column).
- One branch = one coherent piece of work that should ship together. Everything
  on a branch merges, and therefore ships, together.

### 3. While working
- Put tickets on the branch with `assign_to_branch`; take one off with
  `unassign` if it should wait for a later update.
- **Tick a ticket done** (`mark_done`) when its part is finished, so the branch's
  progress in the suite is true.
- Mention `SN-n` in the commit message for the ticket a commit serves
  (`Fix the cart total on the box order tool (SN-568)`). GitHub sync links it.
- Keep the branch current: merge `pre-release` into it before opening the PR,
  and again if `pre-release` moves before you merge.

### 4. Pull requests and merging
- **PRs go into `pre-release`.** Never into `main`.
- In the PR body, list every ticket on its own line: `Closes SN-571`. (In a PR
  body, an `SN-n` only links after a keyword — close/fix/resolve/ref/part of/ticket.)
- **Do not merge without the user saying so.** Merging puts the work in the next
  update. Ask in these words or close to them:
  > Merging `feat/x` puts SN-565, SN-571 in the next update (v3.13.0). Merge it?
- Before merging, check:
  - the branch is up to date with `pre-release`
  - the PR's checks pass (the suite shows migration / cache-buster /
    edge-function warnings on the PR)
  - any migration number is still free — see CLAUDE.md, "The five things that
    will bite you", #4
- After merging, **do nothing to the tickets by hand.** GitHub sync moves every
  ticket on the branch to pre-release, and they appear in the patch notes.
- **Don't delete the branch.** The suite offers deletion once a branch is fully
  merged.

### 5. Never
- Push to `main`, merge into `main`, or open a PR into `main`.
- Merge `pre-release` into `main` "to sync" anything.
- Create tags or GitHub releases, or bump `APP_VERSION` for a release.
- Press, or ask the suite to run, **Go live**. That's a person's decision, made in
  the suite.

All of these belong to Go live, which does them in order: version and
cache-busters → `pre-release` into `main` → tag → GitHub release → patch
notes posted.

### 6. Migrations and edge functions skip GitHub
A migration goes live when it is **applied**; an edge function when it is
**deployed**. Neither waits for a merge or for Go live, so:
- Apply or deploy only when the user OKs it, and say so on the ticket
  (`comment`).
- Code that needs a new column or function must not reach `pre-release` before
  that column or function exists in production.

---

## The connector (`speeksnet-dev`)

A Claude connector for development work. It's separate from the read-only
`speeks-mcp` data connector, because this one writes, and every write is made
**as a specific developer**.

| Tool | Does |
|---|---|
| `dev_board` | The pipeline: next version and size, what's merged, each branch and its tickets, the backlog |
| `get_ticket` | One ticket: description, comments, branch, PR, history |
| `search_tickets` | Find tickets by text, type, stage |
| `create_ticket` | New ticket in the Backlog |
| `start_branch` | Create a branch from `pre-release` and put tickets on it |
| `assign_to_branch` / `unassign` | Move tickets onto or off a branch |
| `mark_done` | Tick / untick a ticket on its branch |
| `comment` | Comment on a ticket |

It deliberately has no Go live, merge or delete. Merging happens on GitHub (a PR
into `pre-release`, after the user says yes), and sync takes it from there.
Every action shows in the ticket's history as **"Claude, for Nick"** (or Ethan).

**Setup (Claude Code):**
- The server is declared in the repo's `.mcp.json`, and its key comes from your
  own environment, never the repo (the repo is public).
- Get your personal key from the suite (your menu → Claude connector), then set
  it once:
  ```powershell
  [Environment]::SetEnvironmentVariable('SPEEKSNET_DEV_KEY', '<your key>', 'User')
  ```
- Restart Claude. A key can be revoked from the same place.

---

## What works today vs. after the pipeline build

| | Today | After the build |
|---|---|---|
| Branch from `pre-release`, PR into `pre-release`, no `main` | ✅ enforced by branch protection | same |
| `SN-n` in commits / `Closes SN-n` in PRs links tickets | ✅ GitHub sync (Phase 4) | same |
| Branch columns, tickets on branches, ticking done | ❌ | ✅ |
| Merge moves the branch's tickets to pre-release | partly (only tickets named in the PR) | ✅ every ticket on the branch |
| The `speeksnet-dev` connector | ❌ | ✅ |
| Go live (version, merge to main, tag, notes) | ❌ done by hand | ✅ |

Until the connector exists, follow rules 1–6 by hand. Name the tickets in
commits and PRs, and tell the user which tickets a branch is for, so they can
put them on it in the suite.
