# SPEEKSNET backups — what is here and how to get things back

A backup runs every night at 2:00 AM (the "SPEEKSNET Backup" task in Windows Task
Scheduler). **`LAST-BACKUP.txt` says whether last night's worked.**

Nothing here restores itself. Every restore below is a deliberate step, and most of
them only put back *one thing* — one table, one file, one branch — so a bad merge can
be undone without rolling the whole site back.

> Easiest route: open Claude Code in the speeksnet repo, say what went wrong and
> which night's backup to use. The steps below are what it will do.

## What is in each dated folder (`2026-09-17_0200`)

| Folder | What | Restores |
|---|---|---|
| `database/speeksnet-full.dump` | The whole Postgres database: every table, the 52 cron jobs, RLS policies, functions, storage and auth records | One table, several, or everything, with `pg_restore` |
| `database/schema.sql` | The same structure as readable SQL | Nothing directly — read or diff it |
| `functions/<name>/` | Each edge function's own deployed source (`source/index.ts`), plus `meta.json` (version, `verify_jwt`) | A function that is not in git, or whose git copy is wrong |
| `functions/_functions.json` | Every function, its version and settings | Redeploy settings |
| `project/` | Auth, API, storage and pooler settings; the **names** of the function secrets | Re-creating settings. Secret **values** are never readable from Supabase — keep those somewhere safe yourself |
| `storage/_files-at-this-time.json` | Every uploaded file that existed that night, with its checksum | Which files to put back |
| `storage/_buckets.json` | Bucket settings (public, size limits, allowed types) | Re-creating a bucket |
| `git/github-all-branches.bundle` | Every branch on GitHub, as it stood that night | A branch, a commit, or history after a force-push |
| `git/this-computer-all-branches.bundle` | This PC's clone, including commits not pushed yet | Local work |
| `manifest.json` | What ran, how long, and anything that failed | — |

Shared across all nights (never deleted by the cleanup):

- `_storage-mirror/<bucket>/` — the actual uploaded files. A file deleted in Supabase
  stays here. A file that was replaced keeps its old copy under
  `_previous-versions/<night>/`.
- `_logs/` — one log per run, kept 90 days.

**Not here, on purpose** — these live in `%LOCALAPPDATA%\SPEEKSNET Backup` on the PC that
runs the backup, because this folder is shared with the team and synced to Google Drive:

- `credentials.xml` — the Supabase access token and database password, encrypted so only
  that Windows login on that PC can read them. Copying it elsewhere does not work.
- `pgsql-17.6-1\` — the PostgreSQL client tools (315 MB of binaries, re-downloadable).
- `speeksnet.git` — the working git mirror, rewritten nightly. The bundles inside each
  snapshot are the actual git backup.

**Secrets are redacted.** `project/postgrest-config.json` carries the project's JWT
secret, and the auth config can carry SMTP and provider secrets; the backup replaces
those values with a note. Nothing is lost: a restored project issues its own JWT secret,
and this project's keys can be read in the dashboard at any time.

**Kept:** the newest backup of each of the last 14 days that have one, plus the newest of
each of the last 8 weeks. A folder ending in `.partial` is a run that failed partway —
read its `manifest.json`; it is cleared after 3 days.

## Restoring

The PostgreSQL tools are on the backup PC at `%LOCALAPPDATA%\SPEEKSNET Backup\pgsql-17.6-1\pgsql\bin`
(on another machine, install PostgreSQL 17 or run the backup once to fetch them).
Connection details are in the night's `project/pooler-config.json` (`db_host`, `db_user`).
Set the password first:

```powershell
$env:PGPASSWORD = '<database password>'
$env:PGSSLMODE = 'require'
$bin = "$env:LOCALAPPDATA\SPEEKSNET Backup\pgsql-17.6-1\pgsql\bin"
$dump = "<backups folder>\2026-09-17_0200\database\speeksnet-full.dump"
```

### See what is in a dump, without touching anything

```powershell
& "$bin\pg_restore.exe" --list $dump | Select-String 'TABLE DATA public'
```

### Get one table's rows back as they were that night

Safest: restore into a **new, differently named** table, compare, then copy across
only the rows you need.

```powershell
# the table as SQL, to read or to run by hand
& "$bin\pg_restore.exe" --data-only --table=listing_goals --file=listing_goals.sql $dump
```

Replacing a live table outright (the rows written since that night are lost):

```powershell
& "$bin\pg_restore.exe" -h <db_host> -p 5432 -U <db_user> -d postgres `
  --data-only --table=listing_goals --disable-triggers $dump
# empty the table FIRST (TRUNCATE public.listing_goals) or rows will duplicate
```

### Everything, into a new Supabase project

Only for a disaster. Create a new project, then:

```powershell
& "$bin\pg_restore.exe" -h <new db_host> -p 5432 -U <new db_user> -d postgres `
  --no-owner --clean --if-exists $dump
```

Expect warnings about Supabase-owned schemas (`auth`, `storage`, `realtime`) — the
new project already has those. The `public` schema, cron jobs and data are what matter.

### A git branch or commit

```powershell
cd C:\Users\User\Documents\GitHub\speeksnet
git bundle list-heads "<night>\git\github-all-branches.bundle"
git fetch "<night>\git\github-all-branches.bundle" "Main-October-Update-1---Ethan:restored/Main-October-Update-1---Ethan"
# the branch as it was that night is now restored/<name>; nothing else changed
```

### An uploaded file

Find it in `storage/_files-at-this-time.json` (the `local` field is its path under
`_storage-mirror/<bucket>/`) and upload that file back to the same bucket and key in the
Supabase dashboard (Storage). For many files, ask Claude to script the upload.

### An edge function

The deployed source is right there: `functions/<name>/source/index.ts`. Copy it into
`supabase/functions/<name>/` in the repo and redeploy, with `verify_jwt` as recorded in
`meta.json` (every function on this project runs with it **off**):

```
npx supabase functions deploy <name> --no-verify-jwt --project-ref ejzaqmyxxrkmxvzbjeuo
```

This is the only copy of the functions that were never committed (`listing-goals`,
`weekly-kpi` and others), so diff against it before assuming the repo is right.

## Keeping the backup running

- The PC has to be **on and signed in** (locked is fine) for the 2 AM run. If it was
  off, the backup runs as soon as the PC is next on.
- **Run one now:** Task Scheduler → SPEEKSNET Backup → Run, or
  `Start-ScheduledTask -TaskName 'SPEEKSNET Backup'`.
- **Token expired or password changed:** run `_tool\Set-BackupCredentials.ps1` again.
- **Moving to a new PC:** copy the repo's `tools\backup` folder, run
  `Set-BackupCredentials.ps1` then `Install-BackupTask.ps1` on the new PC.
