-- ============================================================================
-- 0048_collection_rules — filing the `other` pile into the real collections.
--
-- WHY. Shopify collections are the category system (product_type is blank on
-- 98% of the catalogue), and they are ALL manual — hand-filed by listers, no
-- rule sets. Only `newly-listed-devices` is smart (variant price > $1), which
-- is why every product sits in it. The consequence, measured 2026-08-21:
-- 457 IN-STOCK units sit in `other` and in nothing else, while `networking`,
-- `televisions`, `charging-power`, `car-electronics-audio` and eight more hold
-- ZERO products — empty shelves next to a bin holding their contents.
--
-- That bin is what the Call Back matcher has to guess its way around: the
-- category is its gate, so an item in `other` is only reachable by a
-- multi-word keyword, and its title is the only evidence. Filing the pile is
-- the same work as making the matcher honest.
--
-- HOW A RULE MATCHES. Case-insensitively, on a WORD BOUNDARY, with an optional
-- trailing "s". All three parts were forced by the data:
--   · substring matching put "EMC VNXe3100 Legacy Unified Storage Array" into
--     networking, because `unifi` is inside `unified`.
--   · "Google Nest Cam Security Cameras" did not match `security camera` until
--     the plural was allowed.
-- LONGEST KEYWORD WINS, the same discipline as callback_types: `laptop dock`
-- has to beat `laptop`, `car audio speaker` has to beat `speaker`, and
-- `hearing aid charger` has to beat `charger` or a hearing-aid charger is
-- filed under Charging & Power.
--
-- WHAT A RULE MAY NOT DO. The recategoriser only ever considers a product
-- whose ONLY real collection is `other`. It therefore cannot take a product
-- out of a collection a human put it in — the worst a bad rule can do is move
-- something from `other` to the wrong shelf, which is recoverable, rather than
-- undoing somebody's filing, which is not. `collection_moves` records every
-- add and remove so a bad run can be walked back.
--
-- WHAT DELIBERATELY HAS NO RULE. The honest tail of `other` is commercial AV
-- and building automation (Crestron, Control4, Nuvo, Biamp, Elan, Johnson
-- Controls, Mercury access panels, Symmetry door controllers) and test gear
-- (Fluke, Viava, Paladin). PayMore has no collection for any of it, and
-- `controller` as a keyword would sweep all of it into Video Game Accessories.
-- Those stay in `other`, which is what `other` is for.
--
-- Related: [[shopify-product-taxonomy]], [[callback-shopify-match]].
-- ============================================================================

create table if not exists collection_rules (
  id            bigserial primary key,
  keyword       text not null unique,
  target_handle text not null,
  note          text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

comment on column collection_rules.keyword is
  'Matched case-insensitively on a word boundary, optional trailing s. Longest match wins.';
comment on column collection_rules.target_handle is
  'Shopify collection handle. Not a foreign key: shopify_collections is a cache that a sweep rebuilds.';

-- Every add and remove, so a run can be audited and walked back. dry_run rows
-- are never written here — a proposal is not a move.
create table if not exists collection_moves (
  id            bigserial primary key,
  store_code    text not null,
  product_id    text not null,
  sku           text,
  title         text,
  added_handle  text not null,
  removed_handle text,
  rule_keyword  text,
  applied_at    timestamptz not null default now(),
  undone_at     timestamptz
);

create index if not exists collection_moves_store_idx on collection_moves (store_code, applied_at desc);
create index if not exists collection_moves_product_idx on collection_moves (product_id);

-- House posture: RLS on, no policies. The anon key is public; only the service
-- role (edge functions) touches these. See [[db-rls-convention]].
alter table collection_rules enable row level security;
alter table collection_moves enable row level security;
