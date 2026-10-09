-- 0142 — read-only database access for the "SPEEKSNET" Claude connector.
--
-- The org's claude.ai workspace gets SPEEKSNET data through a custom connector:
-- the speeks-mcp edge function, which speaks MCP and answers with SQL run
-- through ai_readonly_query() below. Ethan's call (2026-10-09): everyone on the
-- SPEEKS Technology Claude org may see all SPEEKSNET data, so this is not
-- per-person scoped. It is scoped against two things only:
--
--   1. CREDENTIALS. eBay/Shopify tokens, login PINs (users.pin and every
--      user_pin column — the PIN IS the login, so reading one is becoming that
--      person), and the small key/value config tables, which are where a secret
--      would land if anyone stored one. None of these columns are granted, so a
--      query naming them fails with "permission denied" rather than returning
--      them. Nobody needs to read a value to keep it out: the rule is by name.
--   2. WRITES. The function is owned by speeks_ai_reader, which holds SELECT
--      and nothing else, and speeks-mcp calls it over GET, which PostgREST runs
--      in a READ ONLY transaction. Either alone would stop an UPDATE; the
--      second also stops a SELECT that calls some other SECURITY DEFINER
--      function that writes.
--
-- Grants are column-level and computed by ai_reader_refresh_grants(), so a
-- table or column added later is NOT visible to the connector until that
-- function is re-run — deliberately: a new column named access_token should
-- have to be let in on purpose, not by default. Re-run it after a migration
-- that adds something the chat should be able to see:
--     select public.ai_reader_refresh_grants();
--
-- pg_catalog is readable by PUBLIC and cannot be revoked per-role, so the
-- function refuses SQL that reaches for function source, settings, cron, vault
-- or pg_net — places where a key can sit inside text that isn't a table.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'speeks_ai_reader') then
    -- BYPASSRLS because the house pattern is RLS-on/no-policy (see 0108): without
    -- it this role would read every table as empty. It still can only SELECT the
    -- columns granted below.
    create role speeks_ai_reader nologin bypassrls;
  end if;
end $$;

-- So postgres can hand ownership of the query function to the role (PG16 gives
-- the creator ADMIN only, without SET).
grant speeks_ai_reader to current_user;
grant usage on schema public to speeks_ai_reader;

create or replace function public.ai_reader_refresh_grants()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deny_tables text[] := array[
    'ebay_stores', 'shopify_stores',
    'app_cache', 'box_order_config', 'expense_settings', 'listing_config', 'watch_config'
  ];
  deny_col_re text := '(^pin$|_pin$|token$|token_|secret|password|passwd|credential|api_key)';
  r record;
  cols text;
  n int := 0;
begin
  -- Start clean so a column that became sensitive (or a table now denied) loses access.
  for r in select c.relname from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p') loop
    execute format('revoke all on public.%I from speeks_ai_reader', r.relname);
  end loop;

  for r in select c.oid, c.relname, c.relkind from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p') loop
    continue when r.relname = any(deny_tables);
    -- A view runs as its owner unless security_invoker is on, so one built over a
    -- denied table would be a window onto it. Skip any view that touches one.
    continue when r.relkind in ('v','m') and exists (
      select 1 from pg_depend d
      join pg_rewrite rw on rw.oid = d.objid
      join pg_class t on t.oid = d.refobjid
      where rw.ev_class = r.oid and t.relname = any(deny_tables)
    );
    select string_agg(format('%I', a.attname), ', ' order by a.attnum) into cols
    from pg_attribute a
    where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
      and a.attname !~* deny_col_re;
    continue when cols is null;
    execute format('grant select (%s) on public.%I to speeks_ai_reader', cols, r.relname);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.ai_reader_refresh_grants() from public, anon, authenticated;

select public.ai_reader_refresh_grants();

create or replace function public.ai_readonly_query(q text, max_rows int default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
set statement_timeout = '20s'
as $$
declare
  body text := regexp_replace(coalesce(q, ''), ';\s*$', '');
  result jsonb;
begin
  if body !~* '^\s*(select|with)\s' then
    raise exception 'Only a single SELECT (or WITH ... SELECT) query is allowed.';
  end if;
  if body ~ ';' then
    raise exception 'One statement per call — remove the semicolon.';
  end if;
  if body ~* '(pg_proc|prosrc|pg_get_functiondef|pg_settings|current_setting|pg_file_settings|pg_authid|pg_shadow|pg_read|pg_ls_|lo_import|lo_get|dblink|\mvault\.|\mcron\.|\mnet\.|\mauth\.|\mstorage\.|\msupabase_)' then
    raise exception 'That system object is off-limits to the SPEEKSNET connector. Query the public tables.';
  end if;
  execute format(
    'select coalesce(jsonb_agg(r), ''[]''::jsonb) from (select * from (%s) s limit %s) r',
    body, greatest(1, least(coalesce(max_rows, 500), 2000))
  ) into result;
  return result;
end $$;

-- ALTER OWNER needs the new owner to hold CREATE on the schema; it is only
-- checked at hand-over, so take it straight back.
grant create on schema public to speeks_ai_reader;
alter function public.ai_readonly_query(text, int) owner to speeks_ai_reader;
revoke create on schema public from speeks_ai_reader;
revoke all on function public.ai_readonly_query(text, int) from public, anon, authenticated;
grant execute on function public.ai_readonly_query(text, int) to service_role;
