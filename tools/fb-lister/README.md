# SPEEKS Marketplace Lister (Chrome extension)

Fills in a Facebook Marketplace "Item for sale" listing from one of our Shopify
items. **It never posts.** A person picks the category, checks everything, and
clicks Next → Publish themselves. Facebook doesn't allow automated posting, and
the listing goes out under that person's own Facebook account.

This started as a store manager's tool that scraped the public PayMore store
sites. It now reads only our own data, through the read-only
`supabase/functions/fb-lister` edge function: each store's Shopify admin (using
the tokens already in `shopify_stores`) plus `ebay_catalog`.

| Path | What it is |
|---|---|
| `extension/` | The unpacked extension (Manifest V3). |
| `SPEEKS-Marketplace-Lister.zip` | What people download. Built from `extension/`. Served by GitHub Pages. |
| `build-zip.ps1` | Rebuilds the zip. |
| `../../scripts/fb-lister-fill-mock.html` | A mock of Facebook's form for testing `content.js` (serve the repo on :8080). |
| `../../scripts/fb-lister-popup-mock.html` | The popup with canned data, for checking its look without installing it. |

The popup and the Facebook panel use SPEEKSNET's own look, with colours copied
from `styles.css`: the dark top nav and white SPEEKS mark, the emerald action
pair, the B2B lines, and the `--qs-*` status palette. Don't add new shades.

## Who can use it
Feature Access key **`fb-lister`**. That key controls both the SPEEKS Tools →
Marketplace Lister download page and the extension's sign-in, because the edge
function checks it on every call. By default it's on for **DMs only**. Switch it
on for anyone else, by person or by role, in Feature Access. The default lives in two places that must agree:
`FEATURE_CATALOG` in `speeks.js` and `FB_LISTER_DEF` in the edge function.

Sign-in uses the person's SPEEKSNET PIN, checked on the server. The extension
then holds a signed 30-day token. Changing someone's PIN or deleting them cuts
it off on the next call.

## One store per person
Anyone whose SPEEKSNET store is one of the five sees only that store: the
catalog, item reads and sold checks are refused server-side for any other
store. CORP people (DM, CEO, MOCD) see all five.

## Public meetup, in the store's city
Marketplace buyers come into the store to buy. Every fill turns on **Public
meetup**, turns off Door pickup and Door drop-off, and sets the listing's
location to the store's city (`STORE_AREA` in `content.js`). That way the
listing reaches people near the store, not near wherever the lister lives.

## Groups
People must **join groups themselves** first; the tool can only use groups
they're already in. The download page, the Groups tab and the panel all say so.

On the "list in more places" step after Next, `content.js` ticks groups (never
unticks, never posts). It applies the person's rules from the popup's Groups tab
first (name contains X → every item / items with keywords / never). Then come
automatic picks: a group with the store's own metro in its name that is
buy/sell or about this kind of item, and isn't about cars, rentals, pets and so
on. National groups are never picked automatically. People join groups
themselves; the Groups tab has Facebook group-search buttons for their area.

## Sold watch
Once a day, the worker checks everything filled from that computer against
Shopify. Daily is enough because Marketplace buyers buy in store. An hourly
alarm only checks once the last check is 24 hours old, so a computer that was
off still catches up. Anything sold shows a badge count and a
notification. Clicking it opens Marketplace → Selling with those listings
outlined; the person clicks Mark as sold. The list is per computer
(chrome.storage.local); nothing is written to SPEEKSNET.

## Shipping a change to the extension
1. Edit `extension/`, then bump `"version"` in `extension/manifest.json`.
2. Set `FB_LISTER_VERSION` in `speeks.js` to the same version.
3. `powershell -File tools/fb-lister/build-zip.ps1`
4. Bump the `speeks.js?v=` cache-buster in the six pages.
5. People download the new zip, extract it over their old folder, and click ↻
   on chrome://extensions.

Changes to the edge function (condition mapping, description cleanup, what
counts as sold) need only a deploy. Nobody has to re-download anything:
`npx supabase functions deploy fb-lister --no-verify-jwt`

## When Facebook changes its form
`content.js` finds fields by their visible label ("Title", "Price",
"Condition", "Description") and never by class name. Every step reports itself
on the panel, so a Facebook change shows up as "Price — not found, type it in"
rather than a silently half-filled listing. Fix the finder in `content.js`,
check it against the mock, and ship a new version.
