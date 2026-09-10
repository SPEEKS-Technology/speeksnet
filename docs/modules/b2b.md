# B2B Deals — module map

Lives in `operations.html` under `#ops-pane-b2b`. Front end: `speeks.js`
**15,524 – 23,230**. Backend: `supabase/functions/b2b-deals/index.ts` (one large
action-dispatch function), plus `b2b-outreach`, `b2b-intake`, `b2b-capture-tool`,
and 30 `*_b2b_*.sql` migrations.

---

## The stage machine

Canonical list and rank function: `supabase/migrations/0018_b2b_review_stage.sql:59-91`.

| Rank | Stage | UI label | Who it waits on |
|---|---|---|---|
| 0 | `declined` | Declined | — |
| 1 | `pickup` | Pickup Sign-Off | whoever collected |
| 2 | `pricing_location` | Pricing Location | corp |
| 3 | `pricing` | Pricing | the pricing store |
| 4 | `review` | Awaiting Approval | **Paul / an ACCEPT_ROLE** |
| 5 | `quote` | Out For Quote | the client |
| 6 | `listing_location` | Listing Location | corp |
| 7 | `listing` | Listing | the listing store |
| 8 | `completed` | Completed | — |

Rank is enforced by CHECK constraints, so **inserting a stage means renumbering
every later rank** and revisiting the three integrity gates at
`0018_b2b_review_stage.sql:79-91`:

- `b2b_deals_pickup_recorded` — rank < 2, or `signed_by` + `signed_at` + `pickup_date`
- `b2b_deals_pricing_located` — rank < 3, or `pricing_store`
- `b2b_deals_listing_located` — rank < 7, or `listing_store` + `accepted_at`

Front end mirrors: `B2B_STAGES` `speeks.js:15546-15556`, stage map `:15557`,
board columns `:15563`, `B2B_ACTIONS` (cta + "why" strings) `:15567-15575`.

"Listed" is not a stage — it is per-unit progress (`listed_qty` /
`recycled_qty` on `b2b_deal_items`, `0001_b2b_baseline.sql:113-114`).

**Payment is not a stage either, deliberately.** `paid_at` / `paid_by` /
`paid_amount` on the deal (`0067`) record it as a fact: paying the client does
not gate listing, since the goods are ours from acceptance, so a stage would
stall a pallet behind an accounts task. The Overview's "Paying The Client"
section reads it.

**`pricing` covers two situations**, told apart by `pricing_started_at`
(`0067`), not by a second stage: nothing has been opened yet ("Awaiting
Pricing") versus somebody is part-way through ("Pricing"). `_b2bStageChip` reads
it. Adding a real stage would mean renumbering every rank above 3 and revisiting
the three integrity gates — see the migration header for why that was not worth
it for one distinction inside a stage.

Separate, parallel pipeline — **pre-evaluations**: `draft / sent / accepted /
converted / declined`, `speeks.js:15639-15650`, schema `0045_b2b_prevals.sql`.
Intake kinds `pickup | walkin`: `speeks.js:15590-15617`, `0044_b2b_walkin_intake.sql`.

## Scope and ownership — read this before debugging "I can't see it"

Every scope test keys off `pricing_store` / `listing_store`, so **a deal with
neither is invisible to everyone but corp** (stated at
`b2b-deals/index.ts:56-57`).

⚠️ **Since 0081 the listing location lives on the ITEM, and the deal keeps a
roll-up.** A deal split across stores has `listing_store` **null** and names its
stores only in `b2b_deals.listing_stores` (a `text[]`, maintained by trigger from
`b2b_deal_items.listing_store`). Anything that tests the single column alone will
hide a split deal from every store working it. Use:

- Client: `_b2bListsHere(deal, mine)` — checks the column **and** the roll-up.
  `_b2bInScope` and both listing branches of `_b2bActionFor` go through it.
- Server: `scoped()` adds `listing_stores.cs.{STORE}` alongside the two original
  predicates. One indexed (GIN) predicate, not a join — which is the whole
  reason the roll-up column exists.
- `_b2bIsSplit(deal)` is `listing_stores.length > 1`. `b2b_deals.listing_store`
  keeps its old meaning: the single store, or null when there is more than one.

**A store sees only its own lines, and the SERVER enforces it.** The item
endpoint takes `?deal_id=X&store=CODE` and filters
`listing_store = CODE OR listing_store IS NULL` — one predicate covering both
ends of the pipeline, since nothing is assigned before acceptance (so a pricing
store still sees every line) and everything is after (so a listing store sees
only its own). The client asks for its own slice via `_b2bScopeQs()`, and **both**
fetch sites must use it: one scoped and the other not means a store sees the
whole deal after a background poll but not on open, which is the worst kind of
leak. A check counts the fetches against the scoped calls.

Filtering in the browser was never an option — it would ship every store's lines
and the deal's whole commercial picture to every store on it.

- Per-action ownership: `_b2bActionFor`. Employees/trainees get the listing
  branch for their own store's deals (3.8.3).
- Role gates: `_b2bCanAccept()` is the "is this corp" gate that assigning a
  listing location and moving lines both use. Deliberately the same one every
  other privileged B2B action uses — a second, subtly different check is how two
  answers to the same question end up in one file.

**Per-store completion.** `b2b_deal_listing_parts` records which store finished
its half and when; `complete` counts outstanding for **that store only**, so one
store is never blocked by another's. The deal reaches `completed` when the last
part lands. A one-store deal is the degenerate case of the same path and behaves
exactly as it always did, which is why 0081 backfilled every existing item.

`b2b_deal_list.listing_parts` (JSONB, one entry per store with its counts, money
and completion) serves corp's per-store progress breakdown and a store's own
numbers on the board from one fetch.

**Moving lines** is `transfer_items`, corp only, logged into
`b2b_deal_transfers` as `kind: 'item'`. It refuses a line with units already
live on Shopify — that listing belongs to the store that made it. Afterwards it
re-reads the roll-up (a deal collapsing back onto one store must stop reading as
split) and drops the destination's part row, because a store handed more work is
no longer finished.

**Gotcha:** on acceptance the listing store is auto-set from the pricing store
*unless the deal was priced at CORP* (`b2b-deals/index.ts:1265-1268`). So
CORP-priced deals land at `listing_location` with `listing_store = null`, have no
owner at any store, and the only screen anyone gets is the bare store picker
`_b2bStageListingLocation` `speeks.js:22041`.

The item fetch **used to have no store check at all** — any authorized caller
with a deal id got every line and the full value/offer/cost rollups. Since 0081
it takes `&store=CODE` and filters (see above), which is what makes "each store
only sees the part brought to their store" true rather than aspirational.
It is still the caller that says which store it is, like `role` — this app has
always trusted the browser on that (see the header in `b2b-deals`), so it is not
a security boundary, it is the client telling the server which rule to apply.
Field-level scoping of contact details is separate and unchanged
(`CONTACT_COLS` / `SCOPED_DEAL_COLS`, applied on the board query).

## Screens

Router `b2bOpenDeal(kind, id)` `speeks.js:19028`.

| Stage screen | Function | Line |
|---|---|---|
| 1 pickup sign-off | `_b2bStagePickup` | 19102 |
| 2 pricing location | `_b2bStageAssign` | 19199 |
| 3 pricing | `_b2bStagePricing` | 21090 |
| 4 quote | `_b2bStageQuote` | 21373 |
| 5 listing location | `_b2bStageListingLocation` | 22041 |
| 6 listing | `_b2bStageListing` | 22106 |
| read-only view | `_b2bStageView` | 22565 |

| List view | Function | Line |
|---|---|---|
| Needs Your Action | `_b2bRenderQueue` | 17058 |
| Pipeline (kanban) | `_b2bRenderPipeline` | 17125 |
| Completed / declined | `_b2bRenderFinished` | 17260 |
| Clients | `_b2bRenderClients` | 17337 |
| **Overview (Paul's dashboard)** | `_b2bRenderOverview` | 17925 |
| Pre-evaluations | `_b2bRenderPrevals` | 18328 |

Entry point / view routing: `b2bRender` `:16985-17054`, view setter `:16975`.
Overview sections: stalled ≥7 days `:17936`, open quotes split to-approve vs
with-client `:17951-17963`, bought-but-not-listed `:17966`, tiles `:17986-17996`.

## Pricing sheet

Grid `_b2bItemSheet()` `speeks.js:20738` (header 20752, rows 20767). Excel-style
cell selection at `:20611`.

**Persistence is per-field autosave on blur — no Save button, no save on close.**
Cells are `oninput="b2bItemInput(...)"` (local only, `:20110`) plus
`onchange="b2bItemSave(...)"` (the only writer, `:20126`, posts the whole line).
Close handlers save nothing: `b2bCloseItemSheet` `:20944`, `b2bCloseDeal`
`:16128`, `closeAllModals` `:482` (B2B cleanup `:518-522`).

⚠️ **Known hole:** an edit still focused when the modal is dismissed by Escape or
an overlay click never fires `change` and is lost. There is no `beforeunload` or
flush guard anywhere in the B2B region.

Money fields per line: `value`, `offer`, `shipping_cost`, `wipe_fee`, `cost`,
plus derived Margin (`_b2bLineGrossHtml` `:19421`, rendered `:20850`) and Net
margin (`_b2bLineNetHtml` `:19427`, rendered `:20860`). None are role-gated.

**Three separate note fields, easy to confuse:**

| Field | Edited where | Shown in listing? |
|---|---|---|
| `client_notes` | grid col `:20872-20877` | no |
| `staff_notes` (internal) | row `+` panel `:20547-20551` | no |
| `listing_info` | **no UI at all** | no |

`listing_info` was added *for the lister* (`0047_b2b_listing_info_and_label_printed.sql:26`)
and is written by the bench capture tool
(`tools/b2b-capture/SPEEKS-Collate.ps1:282-290`, `b2b-intake/index.ts:191`) — but
no screen displays it. eBay research links land in a column nobody sees.

**Serial popup** `b2bSerialsOpen` `:20558`, paint `:20574`, close `:20600`. It is
appended to `document.body` (`:20568`), *not* the row — which defeats the
live-sync focus guard at `:16929-16930`. Saving happens only in
`b2bSerialsClose` (`:20606`).

**Reordering** `:19800-19858`. The whole SKU cell is `draggable="true"`
(`:20810-20813`), so it fights text selection; `b2bDragOver` (`:19821-19830`)
has no above/below logic, so `b2bDrop` always inserts at the hovered index.
Order persists as `sort_order` (`0020_b2b_item_sort_order.sql`) and the quote
renderers walk the same array — arranging the sheet arranges the client's quote.

## Quote

Generation is entirely client-side: `_b2bQuoteDoc` `:21668`,
`_b2bQuoteInlineHtml` `:21737`, `_b2bQuoteText` `:21829`, totals `:21617`,
description `:21631`, foot notes `:21637`, client block `:21660`, subject `:21900`.

**Sending is a `mailto:` draft, not a server send** — `b2bSendQuote` `:21910` puts
rich HTML + plain text on the clipboard, `_b2bShowSendStep` `:21938`,
`b2bOpenDraft` `:21980-21999` fires the mailto then POSTs `send_quote`. Rationale
at `:21890-21899`: the client's reply must land with whoever quoted them. So
`quote_sent_at` records only that a draft was *opened* — "sent" is trust-based.
No PDF, no delivery confirmation.

Server gates (`b2b-deals/index.ts:1199-1219`): must be at `review` or `quote`;
leaving `review` requires an ACCEPT_ROLE (CEO/MOCD/DM). **Sending *is* the
approval — there is no separate approve button.** `accept_quote` `:1222-1276`
requires stage `quote` plus approval on record `:1242`.

## Listing

Grid `_b2bListRows()` `speeks.js:22207-22300`; columns are Line / Item / CPU /
RAM / Storage / Serials / Value / Cost / Listed — **no notes of any kind**.

Listed-count stepper `:22286-22288` (`−` `b2bUnlistUnit`, `+` `b2bAskShopify`);
`+` is disabled on recycle lines (`:22241`). `recycled_qty` renders as static
text `:22287`.

**Barcodes:** uniqueness is `(item_id, shopify_barcode)`
(`0054_b2b_listing_barcode_per_line.sql`) and a repeat scan is *meant* to bump
`units` — `_b2bListUnit` `:22435-22438` and the server `index.ts:1385-1391` both
do. But a client-side check at **`:22385-22387`** rejects it first, contradicting
both. The 8-digit shape check at `:22377-22384` is the legitimate one.

**Cost is per unit, frozen at acceptance** (`0001_b2b_baseline.sql:90,110`;
`index.ts:1221,1258`). Line cost is computed `per-unit × full quantity` in three
places that all ignore `recycled_qty`: `:22236`, `:17562`, `:22585-22586`.
`recycle_units` (`index.ts:1325-1331`) only bumps a counter — it touches nothing
financial, and there is **no un-recycle action**.

## Notifications

**Added 2026-09-07.** Before that B2B produced exactly one queue row (the delete
request) and one email, which is why Paul reported twice that nothing told him a
deal was waiting on him — he was right, there was nothing to get.

`notifyStage` in `b2b-deals` queues a row on every transition that leaves a deal
waiting on somebody, under category `requests` ("Requests Waiting On Me") — the
home `notify/index.ts` had reserved for it, so no new category and no
`notify_queue` CHECK change. Kinds, and who each reaches:

| Transition | kind | Audience |
|---|---|---|
| `sign_pickup` → `pricing_location` | `b2b_pricing_location` | corp |
| `sign_pickup` / `assign_pricing` → `pricing` | `b2b_pricing` | the pricing store |
| `submit_pricing` → `review` | `b2b_quote_ready` | approvers, **high** |
| sendback → `pricing` | `b2b_sendback` | the pricing store (or corp), **high** |
| `accept_quote` → `listing_location` | `b2b_listing_location` | corp |
| `accept_quote` / `assign_listing` → `listing` | `b2b_listing` | the listing store |

All muted together by the `b2b_stage` sub (`notify/index.ts`, under `requests`),
which also finally governs `b2b_delete_request` — that had been queueing with no
sub, so it could not be muted even in principle. Corp-facing kinds carry
`audienceFeature: "cap-b2b-corp"`, so a manager lent the corp hat is told too.
`excludeUser` keeps each one out of the inbox of whoever caused it.

`submit_pricing` **also** still emails, via `notifyQuoteReady` → `b2b-outreach`
`sendQuoteReady`, addressed to the `b2b_quote_ready` recipient list with a
fallback to the single CRM `notify_email`. Both channels on purpose: the email is
what Paul originally asked for, and the queue row is the half that survives a
mail relay failing silently.

⚠️ **The email path was configured correctly the whole time** Paul was reporting
it broken — `b2b_crm_settings.notify_email` is his address with both toggles on,
the shared secret matches, the call is awaited, and both functions were deployed
with the code. So whatever failed was downstream in the relay (`GMAIL_RELAY_URL`,
else Resend) and left no trace. There is deliberately no `b2b_quote_ready` row in
`email_recipients`: an empty list is what makes `quoteReadyTo` fall back to the
CRM address, and creating the list would remove that safety net.

The generic system: `notify_queue` (`0033_email_notifications.sql:80-121`),
categories `notify/index.ts:68-71`, prefs/subs `:162-252`, bell UI
`speeks.js:748` / `:24812` / `openHubTo` `:39599`.

In-app realtime is separate and is **pull, not push**: broadcast
`index.ts:368-400` → `_b2bRealtimeRefresh` `speeks.js:16735`, 60s poll floor
`_startB2bSync` `:16754`. That repaints the board for someone already looking.

The daily cron (`0008_b2b_outreach_cron.sql`) sends client reach-out reminders
only (`b2b-outreach:526-560`) — no stalled-deal or unanswered-quote chase.

**Latent bug found while doing this, not fixed:** `notify_queue`'s category CHECK
constraint allows only seven categories and does **not** include `categories`,
which `notify/index.ts` lists and `0057`/`0066` added preferences for. Nothing
has ever inserted a `categories` row, so it has not bitten yet — but the first
one will fail the constraint.

## Live collaborative pricing

`speeks.js:16771-16972`. `_b2bSyncOpenDeal` `:16841` merges server state into the
open deal. It protects a row from remote overwrite **only while the caret is
inside that row** (`:16929-16930`), and blind-overwrites a field list at
`:16955-16958`. The comment at `:16951-16954` still assumes serials live in the
row panel — they don't any more (see the serial popup note above).

`_b2bSyncOpenDeal` also re-opens the pickup screen when a signature lands
(`:16846-16854`) **without capturing `_b2bPickupDraft`** — the draft-preservation
mechanism at `:19582`, used by `b2bSignHere` `:19583-19590` and `b2bSkipSign`
`:19494-19499` (whose comment describes the resulting field-wipe bug), consumed
at `:19105-19108`, cleared at `:19168`.

## Attribution and audit

Stored as **free-text display names, never user ids** — `_b2bUser()`
`speeks.js:15783` reads `sessionStorage`. There is no `user_id` or FK in the B2B
schema at all, so attribution is spoofable and breaks on a name change.

Deal columns (`0001_b2b_baseline.sql:55-86` unless noted): `created_by`,
`signed_by`/`signed_at`, `delivered_by`/`received_by`, `priced_by`,
`quote_sent_at`/`quote_send_count`, `accepted_by`/`accepted_at`, `declined_by`
(`0002:38`), `sendback_by`/`_at` (`0009:110`), `signature_by` +
`signature_skipped_by`/`_reason` (`0022:42,45`), `approval_waived_by`/`_reason`
(`0050:90,94`), `delete_requested_by` (`0052:13`).

Append-only histories (the only real ones): `b2b_deal_transfers`
(`0021:20-30`), `b2b_item_listings.listed_by` (`0005:36`), `b2b_approval_proofs`
(`0050:55`), `b2b_outreach_log` (`0006:57-66`).

**No generic per-row change log.** Each stage keeps one `*_by` column, so a
re-price by a second person overwrites `priced_by`, and there is no history of
who edited an item's `value`/`offer`.

## Other pieces

- **Pickup date** `pickup_date` `0001:63`. Written by `sign_pickup`, which rejects
  any deal past `pickup` — and, since 2026-09-07, correctable afterwards by
  `update_pickup_date` (corp only, no future dates, and it appends what changed
  to `internal_note`). The pencil is in `_b2bSummary`. Before that there was no
  path at all and a wrong date needed direct DB access, which is what Paul hit on
  Loch Lloyd. Walk-ins still get `todayCentral()` server-side with no field shown.
- **Deal-level edits**, all added 2026-09-07 and all absent before it — there was
  no way to change a deal row after the stage that wrote it:
  `update_pickup_date`, `set_quote_sent` (records a quote sent by hand, outside
  the mailto flow), `set_notes` (`quote_note` / `internal_note`, open through
  `OPEN_STAGES`), `mark_paid` (corp only, accepted deals only, `paid_at: null`
  clears), `start_pricing` (idempotent; stamps `pricing_started_at` the first
  time the sheet is opened).
- **Approval evidence** panel `_b2bProofPanel`, attaching `_b2bAttachMailFile`,
  schema `0050_b2b_approval_proofs.sql` — private bucket, path on the row (never
  a signed URL), bytes streamed back through the edge function, removal is a
  tombstone not a delete. The `kind` CHECK still allows
  `('email','screenshot','document','note')` because historical rows use them,
  but **only `email` is written now** and the server's `PROOF_KINDS` is
  `["email"]`.

  **Dragging a message out of Outlook is the whole feature, and it is where the
  bodies are buried.** Read `_b2bDropFilePromise`'s banner before touching any
  of it — three releases went into it and each fixed a different wrong
  assumption:

  - Outlook offers a message as a **virtual file** (`FileGroupDescriptorW` +
    `FileContents`); the bytes live in the PST/OST or on Exchange, never on
    disk. `dataTransfer.files` is empty and `getAsFile()` returns null. Chrome
    76+ and Edge handle it natively (it streams the contents and writes a temp
    file); **Firefox never has**, and Outlook in a browser tab or the new
    Outlook app cannot offer a file at all. `_b2bDropAdvice` tells these apart.
  - **Do not filter on `item.kind`.** The virtual-file item does not reliably
    report `"file"` — `"string"` has been seen — and a `kind !== 'file'` guard
    skips the only item carrying the message. Every retrieval call returns null
    harmlessly on a real string item, so there is nothing to gain by filtering.
  - **Try every route on every item and do not stop at the first item** that
    offers something: `files[0]`, `getAsFile`, `getAsFileSystemHandle`,
    `webkitGetAsEntry` (following a directory entry one level). A dud entry on
    `items[0]` used to hide a good one on `items[1]`.
  - **Everything is started synchronously.** A `DataTransfer` is neutered the
    moment the handler yields, so reading `items` after an `await` returns an
    empty list and looks identical to an empty drop. Every route is kicked off
    in the handler and the promises settled afterwards, each with a 20s timeout
    because `entry.file()` can fire neither callback.
  - Naming is **accept-by-exclusion** (`B2B_NOT_MAIL_RX`), because Windows hides
    extensions and Outlook names the virtual file after the subject line.
    `_b2bAsMailFile` renames a virtual file to `.msg`, gated on the extension
    regex directly — gating it on `_b2bIsMailFile` left MSG bytes under an
    `.eml` MIME, which Outlook then refuses to open.
  - Last resort: `_b2bEmlFromDragText` builds a real `.eml` from the drag's
    text when no route yields bytes, gated on the text carrying mail headers or
    passing `B2B_DRAG_TEXT_MIN`. Labelled "(message text only)" on the record —
    a fabricated proof is worse than none.
  - `tools/outlook-drop-test.html` is a standalone probe (no app, no session, no
    network) that runs the same routes and reports each one. It exists because a
    real Outlook drag cannot be reproduced from a dev machine or headless
    Chrome — there is no Outlook in either.
- **Attaching when blocked** — `_b2bApprovalGate(owner, ownerId, ownerKind)`
  opens `b2bOpenAcceptProof` instead of alerting, so Mark Accepted with no
  evidence on file presents the drop zone rather than telling the user to go
  and find one. The old multi-field dialog (kind picker, From/Dated/Label,
  paste-the-body) was removed 2026-09-09; the popup is drop-zone plus the one
  remaining file picker in the product. Two zones can be live at once, so the
  zone id is separate from the deal id (`B2B_PROOF_POP`).
- **Transfers between stores** `_b2bTransferKind` `:19714`, `b2bOpenTransfer`
  `:19728`, server `index.ts:1080-1093`.
- **Labels** `b2bPrintLabels(dealId, itemId, count)` `:23029`; holding tag
  `b2bPrintHoldingLabel` `:23010`; pallet tag `b2bPrintPickup` `:23207`; shared
  window opener `_b2bOpenSheet` `:22989`; shared tag doc `_b2bTagSheet` `:22888`.
  The bulk branch at `:23073-23079` prints every line when `itemId` is falsy —
  it works, but **every call site passes an itemId** (`:19292`, `:20384`), so
  there is no mass-print button. Shortfall machinery: `_b2bLabelsShort` `:19982`,
  `_b2bUnlabelled` `:19986`, warning `:21163-21173`, write-back `:23183-23198`.
  ⚠️ `b2bPrintHoldingLabel` reads the persisted row (`:23022`, `:23024`), never
  the live pickup form (`#b2bPuSigned` `:19132`, `#b2bPuDesc` `:19126`).
- **SPEEKS Capture tool** distribution + version history `:16225`, edge fn
  `b2b-capture-tool`, `0066_b2b_capture_releases.sql`. Source in
  `tools/b2b-capture/` — its README is the source of truth.
- **CRM settings** (CEO only) `:17663-17880` — recipient config, load `:17686`,
  settings HTML `:17836-17845`, save `:17861-17877`; registration `:33686-33688`.
