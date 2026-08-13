-- Email notifications: per-person opt-in, an event queue, and a send ledger.
--
-- The site's alerts are all computed IN THE BROWSER: _samReminderCfg reads ~14
-- hidden bubbles that each check*() fills from an edge function, and the feed
-- adds announcements, store comments and patch notes on top. Nothing server-side
-- has ever known "what is outstanding for this person", which is exactly what an
-- email needs. These three tables are that missing half.
--
-- The split down the middle of the feature, and the reason for two tables
-- instead of one:
--   * EVENTS (an announcement is posted, a request comes in, a reply lands) are
--     real writes. The function doing the write already calls broadcastChange();
--     it now also drops a row in notify_queue naming who should hear about it.
--   * DUE DATES (KPIs, listing goals, GP goals, expenses) are not writes at all
--     — nothing happens, and that IS the alert. Those cannot be queued at write
--     time; the notify function recomputes them on a schedule. They never touch
--     notify_queue, only notify_sent (for the "already told them today" check).


-- ============================================================
-- 1. WHO WANTS EMAIL, AND ABOUT WHAT
-- ============================================================
-- ⚠️ KEYED ON NAME, NOT users.id, AND DELIBERATELY WITHOUT A FOREIGN KEY.
-- The Permissions tool saves by full replace: the auth function runs
-- `delete from users where pin <> ''` and re-inserts the whole list WITHOUT an
-- id column (see auth/index.ts) — so every save mints a brand-new uuid for every
-- person. A foreign key to users(id) would cascade and wipe everybody's
-- notification settings every time the DM edited one person's role. Keying on
-- pin has the same problem one step removed, because a pin can be edited.
--
-- The lowercased name is what the rest of the site already treats as a person's
-- identity for their own state — speeksUnseenPatchNotes_<user>, the snooze map
-- in samRemDismissed_<user>, the expense filed-assertion — so this is the
-- consistent choice rather than a new one. Known limit, shared with all of the
-- above: RENAMING somebody in the Permissions tool orphans their settings and
-- they silently go back to defaults (email off). Rare, recoverable by re-opening
-- the popout, and much better than the cascade.
create table if not exists public.user_notify_prefs (
    user_name   text primary key,            -- lower(trim(users.name))
    email       text,
    -- Master switch, default OFF. Turning email on is a deliberate act; nobody
    -- gets mail because a category defaulted true underneath them.
    enabled     boolean not null default false,
    -- 'instant' = batched every 15 minutes, which is as instant as a cron can be
    --             and still collapse a burst into one email.
    -- 'digest'  = held for the single 7am sweep.
    -- A high-priority announcement ignores this and goes out on the next drain
    -- either way — see the notify function.
    cadence     text not null default 'instant' check (cadence in ('instant', 'digest')),

    -- The seven toggles the popout shows. Each maps to a GROUP of the alerts
    -- inventoried on this branch (see CATEGORY_ALERTS in the notify function —
    -- that map is the authority; these columns are just the on/off bits).
    -- Default true so that flipping `enabled` on gives a sensible full
    -- subscription rather than an email that never arrives.
    cat_announcements  boolean not null default true,  -- announcements (incl. priority), patch notes
    cat_store_messages boolean not null default true,  -- store comment from a DM / CEO / Manager
    cat_requests       boolean not null default true,  -- B2B deals + quotes, purchase requests, recycle
    cat_claims         boolean not null default true,  -- insurance claims aging past 7 days
    cat_variance_aging boolean not null default true,  -- variance + aging inventory, uploads AND due clocks
    cat_deadlines      boolean not null default true,  -- KPIs, listing goals, GP goals, expense report
    cat_scores         boolean not null default true,  -- SPEEKS scorecard, PayMore practice + official audits

    updated_at  timestamptz not null default now()
);

-- The drain reads "everyone who is switched on" on every run, and that is the
-- only query shape this table ever sees at volume.
create index if not exists user_notify_prefs_enabled_idx
    on public.user_notify_prefs (enabled) where enabled;


-- ============================================================
-- 2. THE EVENT QUEUE
-- ============================================================
-- One row per newsworthy write, inserted by the function that did the write.
-- Rows describe the AUDIENCE, not the recipients: the writing function knows
-- "this store's managers" but must not have to enumerate people or read anyone's
-- preferences. The drain resolves audience -> people -> preferences -> email.
create table if not exists public.notify_queue (
    id          bigserial primary key,
    -- Which of the seven toggles gates this row. Must match a cat_* column above.
    category    text not null check (category in (
                    'announcements', 'store_messages', 'requests',
                    'claims', 'variance_aging', 'deadlines', 'scores')),
    -- The specific alert inside that category ('patch_notes', 'b2b_quote_ready',
    -- 'aging_reply', …). Carried so an email can name the actual thing and so
    -- the ledger is legible when something looks wrong.
    kind        text not null,
    title       text not null,
    body        text,
    -- Deep link, relative ('workspace.html#vreplies'). The feed cards already
    -- know these routes; the email reuses them so a click lands on the tool.
    link        text,
    store       text,                        -- the store it concerns, for the email copy

    -- AUDIENCE. null means "not filtered on this axis":
    --   audience_stores  null = every store            (e.g. a company announcement)
    --   audience_roles   null = every role
    --   audience_user    set  = this ONE person, and the two above are ignored
    --                           (a request answered, an expense report owed)
    audience_stores text[],
    audience_roles  text[],                  -- stored lowercased, matched lowercased
    audience_user   text,                    -- lower(trim(name))

    -- Don't email somebody about their own write. This is the mail-side twin of
    -- _rtMute in speeks.js: the realtime channel broadcasts to the sender too,
    -- and for the same reason the queue would otherwise tell a DM that a DM
    -- posted an announcement.
    exclude_user    text,                    -- lower(trim(name))

    -- 'high' rides the next drain even for people on the daily digest.
    priority    text not null default 'normal' check (priority in ('normal', 'high')),

    created_at   timestamptz not null default now(),
    processed_at timestamptz                 -- set by the drain, once, per row
);

-- The drain's one hot query: unprocessed rows, oldest first.
create index if not exists notify_queue_pending_idx
    on public.notify_queue (created_at) where processed_at is null;


-- ============================================================
-- 3. THE SEND LEDGER
-- ============================================================
-- Every attempt, one row, keyed by a string that makes a double-send impossible.
-- This is the ONLY thing standing between a recurring reminder and mailing
-- somebody the same nag every quarter hour: "Set Today's Listing Goals" is true
-- from 9am until the goals are entered, so the drain must be able to ask "have I
-- already told this person about this, for this period?" and the answer has to
-- survive restarts. Hence a table, not memory.
--
-- dedupe_key shapes (built in the notify function, never parsed here):
--   'q:<notify_queue.id>:<user_name>'      one queued event, one person
--   'due:<slug>:<period>:<user_name>'      a due-date nag, once per period
--                                          e.g. due:kpiWeekly:2026-W33:ethan
--   'welcome:<user_name>:<email>'          the confirmation on saving an address
-- The period component is what lets a WEEKLY reminder re-send next week while
-- staying silent for the rest of this one.
create table if not exists public.notify_sent (
    id          bigserial primary key,
    dedupe_key  text not null unique,
    user_name   text not null,
    email       text not null,
    subject     text,
    -- 'sent' | 'failed'. Failures are recorded rather than retried: the relay is
    -- Gmail via Apps Script and a hard bounce will not fix itself on a retry, so
    -- a stuck row would mail somebody the same thing on every drain forever.
    status      text not null default 'sent' check (status in ('sent', 'failed')),
    error       text,
    sent_at     timestamptz not null default now()
);

create index if not exists notify_sent_user_idx on public.notify_sent (user_name, sent_at desc);


-- Service role only, exactly like every other table behind the edge functions.
-- No policies on purpose: the anon client must never read anyone's address, and
-- every read the site does goes through the notify function.
alter table public.user_notify_prefs enable row level security;
alter table public.notify_queue      enable row level security;
alter table public.notify_sent       enable row level security;


-- Retention. The queue is a work list, not a record — once drained it is dead
-- weight, and the ledger only needs to reach back far enough to answer the
-- longest dedupe window (monthly reminders, so a couple of months is ample).
-- Called by the notify function at the end of a drain, so there is no extra
-- cron entry to forget about.
create or replace function public.notify_prune() returns void
language sql
security definer
set search_path = public
as $$
    delete from public.notify_queue
     where processed_at is not null and processed_at < now() - interval '14 days';
    delete from public.notify_sent
     where sent_at < now() - interval '120 days';
$$;
