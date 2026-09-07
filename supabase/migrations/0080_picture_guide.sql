-- ============================================================================
-- PICTURE GUIDE — the binder of photo printouts, moved into SPEEKSNET.
--
-- Every picture station has a binder of laminated sheets: one page per category,
-- showing each photo a lister must take, in the order it goes on the listing.
-- This replaces the binder, so the shape of the data is the shape of the page.
--
-- THE NUMBERS ARE NOT STORED, AND THAT IS THE WHOLE POINT.
-- On paper a category is a fixed grid with printed numbers, which forces the
-- sheet to fudge the conditional shots: "Everything Included" and "About Phone"
-- are BOTH numbered 2, because whichever one applies is the real number 2. Three
-- separate shots on the tablet sheet are numbered 4. The paper cannot resolve it;
-- the lister does that in their head, every item, all day.
--
-- So pg_shots stores ORDER ONLY (sort_order) plus whether a shot is conditional.
-- The position a shot occupies is derived at render time by walking the list and
-- skipping the conditionals that do not apply to the item in the lister's hand.
-- Nothing here should ever grow a "number" column: the day it does, the tool is
-- a photograph of the binder rather than a replacement for it.
--
--   cond_label   NULL   => always taken. Non-null => the red heading on the sheet
--                          ("Everything Included", "Only if needed"), and the
--                          label of the toggle the lister ticks.
--   repeatable   the printed "+" (4+, 12+): take as many as the item needs, so
--                the shot occupies a RANGE of positions, not one.
--   note         the red instruction text printed on a grey slot where the sheet
--                has words instead of an example photograph.
--   image_path   object name inside the public 'picture-guide' bucket. NULL
--                renders the grey instruction slot, which is exactly what the
--                printout does when it has no example either.
--
-- Reference data: identical for every store, no per-store rows, no RLS beyond
-- shutting the anon key out of writes. The edge function is the only writer.
-- ============================================================================

create table if not exists public.pg_categories (
    id          bigserial primary key,
    slug        text not null unique,
    name        text not null,
    sort_order  int  not null default 0,
    active      boolean not null default true,
    updated_at  timestamptz not null default now(),
    updated_by  text
);

create table if not exists public.pg_shots (
    id           bigserial primary key,
    category_id  bigint not null references public.pg_categories(id) on delete cascade,
    label        text not null,
    -- NULL means "always taken". See the header: this is what makes the
    -- numbering derivable instead of printed.
    cond_label   text,
    repeatable   boolean not null default false,
    note         text,
    image_path   text,
    sort_order   int not null default 0,
    updated_at   timestamptz not null default now(),
    updated_by   text
);

create index if not exists pg_shots_category_idx on public.pg_shots (category_id, sort_order);

-- A shot that is always taken cannot be repeatable: "+" only ever appears on the
-- sheet next to a red conditional heading, because "take as many as you need" is
-- meaningless for a shot every item gets exactly one of. Enforced here so a
-- future writer cannot produce a sheet the render has no way to number.
alter table public.pg_shots drop constraint if exists pg_shots_repeat_needs_cond;
alter table public.pg_shots add constraint pg_shots_repeat_needs_cond
    check (not repeatable or cond_label is not null);

revoke all on public.pg_categories from anon, authenticated;
revoke all on public.pg_shots      from anon, authenticated;
alter table public.pg_categories enable row level security;
alter table public.pg_shots      enable row level security;

-- ----------------------------------------------------------------------------
-- The example photographs. Public like ann-docs and audit-photos: these are
-- pictures of a tablet on a lightbox, there is nothing to protect, and a public
-- URL means the board renders as plain <img> with no signing round-trip per
-- slot. Sixteen slots per category at ~150KB each makes that round-trip the
-- difference between instant and visibly loading.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('picture-guide', 'picture-guide', true, 10485760,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- ann-docs and audit-photos were given their policies through the dashboard, so
-- there is no in-repo precedent to copy. Guarded, because re-running a migration
-- must not fail on a policy that already exists, and because a hosted project
-- can refuse ownership of storage.objects — if this block is skipped, mirror the
-- audit-photos policies in the dashboard by hand and nothing else changes.
do $$
begin
    begin
        create policy "picture guide readable by anyone"
            on storage.objects for select
            using (bucket_id = 'picture-guide');
    exception when duplicate_object or insufficient_privilege then null;
    end;
    begin
        create policy "picture guide writable by the app"
            on storage.objects for insert
            with check (bucket_id = 'picture-guide');
    exception when duplicate_object or insufficient_privilege then null;
    end;
    begin
        create policy "picture guide replaceable by the app"
            on storage.objects for update
            using (bucket_id = 'picture-guide');
    exception when duplicate_object or insufficient_privilege then null;
    end;
end $$;

-- ============================================================================
-- SEED — the three printouts Ethan sent, transcribed exactly.
--
-- Transcribed with the paper's own quirks intact, including "About Phone" on the
-- tablet sheet (Android's settings screen is called that whatever the device is)
-- and the CPU sheet's two separate Extra Accessories slots, which are one
-- repeatable shot here because that is what two identical slots meant.
--
-- Every image_path is NULL: the photographs exist, they have not been uploaded
-- yet, and a NULL renders the grey instruction slot rather than a broken frame.
-- ============================================================================
insert into public.pg_categories (slug, name, sort_order) values
    ('android-tablets', 'Android Smart Tablets', 10),
    ('apple-watches',   'Apple Watches',         20),
    ('processors',      'Processors (CPU''s)',   30)
on conflict (slug) do nothing;

-- sort_order in tens, so a DM inserting a shot between two others has somewhere
-- to put it without a full renumber.
with c as (select id, slug from public.pg_categories)
insert into public.pg_shots (category_id, label, cond_label, repeatable, note, sort_order)
select c.id, v.label, v.cond_label, v.repeatable, v.note, v.sort_order
from c
join (values
    -- ---- Android Smart Tablets ----
    ('android-tablets', 'Home/Lock Screen',                 null,                  false, null, 10),
    ('android-tablets', 'Everything Included',              'Everything Included', false, 'Everything Included', 20),
    ('android-tablets', 'About Phone',                      null,                  false, null, 30),
    ('android-tablets', 'Storage Information',              null,                  false, null, 40),
    ('android-tablets', 'Setting Unlock Screen',            'Unlock screen set',   false, 'Setting Unlock Screen', 50),
    ('android-tablets', 'LCD Flaws',                        'LCD flaws',           true,  'LCD Flaws (Bright Spots, Dark Spots, etc.)', 60),
    ('android-tablets', 'Screen Off',                       null,                  false, null, 70),
    ('android-tablets', 'Back of Tablet',                   null,                  false, null, 80),
    ('android-tablets', 'Bottom Side of Tablet',            null,                  false, null, 90),
    ('android-tablets', 'Top Side of Tablet',               null,                  false, null, 100),
    ('android-tablets', 'Top Corner of Tablet',             null,                  false, null, 110),
    ('android-tablets', 'Opposite Top Corner of Tablet',    null,                  false, null, 120),
    ('android-tablets', 'Bottom Corner of Tablet',          null,                  false, null, 130),
    ('android-tablets', 'Opposite Bottom Corner of Tablet', null,                  false, null, 140),
    ('android-tablets', 'Cosmetic Flaws',                   'Cosmetic flaws',      true,  null, 150),
    ('android-tablets', 'Extra Accessories',                'Extra accessories',   true,  'Extra Accessories', 160),

    -- ---- Apple Watches ----
    ('apple-watches',   'Lock/Home Screen',        null,                    false, null, 10),
    ('apple-watches',   'Everything Included',     'Everything Included',   false, 'Everything Included', 20),
    ('apple-watches',   'Settings Page',           null,                    false, null, 30),
    ('apple-watches',   'Battery Health',          null,                    false, null, 40),
    ('apple-watches',   'LCD Flaws',               'LCD flaws',             true,  'LCD Flaws (Bright Spots, Dark Spots, etc.)', 50),
    ('apple-watches',   'Screen Off',              null,                    false, null, 60),
    ('apple-watches',   'Side of Watch',           null,                    false, null, 70),
    ('apple-watches',   'Opposite Side of Watch',  null,                    false, null, 80),
    ('apple-watches',   'Back of Watch',           null,                    false, null, 90),
    ('apple-watches',   'Bottom of Watch',         null,                    false, null, 100),
    ('apple-watches',   'Top Side of Watch',       null,                    false, null, 110),
    ('apple-watches',   'Bottom Side of Watch',    null,                    false, null, 120),
    ('apple-watches',   'Apple Warranty',          'Warranty still active', false, null, 130),
    ('apple-watches',   'Cosmetic Flaws',          'Cosmetic flaws',        true,  null, 140),
    ('apple-watches',   'Extra Accessories',       'Extra accessories',     true,  'Extra Accessories', 150),

    -- ---- Processors (CPU's) ----
    ('processors',      'Front of CPU',          null,                  false, null, 10),
    ('processors',      'Everything Included',   'Everything Included', false, null, 20),
    ('processors',      'Back of CPU',           null,                  false, null, 30),
    ('processors',      'Top Side of CPU',       null,                  false, null, 40),
    ('processors',      'Bottom Side of CPU',    null,                  false, null, 50),
    ('processors',      'Side of CPU',           null,                  false, null, 60),
    ('processors',      'Opposite Side of CPU',  null,                  false, null, 70),
    ('processors',      'Cosmetic Flaws',        'Cosmetic flaws',      true,  'Cosmetic Flaws (Cracks, Heavy Scratching, etc.)', 80),
    ('processors',      'Extra Accessories',     'Extra accessories',   true,  null, 90)
) as v(slug, label, cond_label, repeatable, note, sort_order)
  on v.slug = c.slug
-- Re-running the migration must not double every sheet. There is no natural key
-- to conflict on (two shots may legitimately share a label), so the guard is
-- "seed only into a category that is still empty".
where not exists (select 1 from public.pg_shots s where s.category_id = c.id);
