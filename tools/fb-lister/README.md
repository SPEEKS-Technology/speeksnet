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

## Who can use it
Feature Access key **`fb-lister`**. That key controls both the SPEEKS Tools →
Marketplace Lister download page and the extension's sign-in, because the edge
function checks it on every call. By default it's on for managers and up (not
employees or the store board). The default lives in two places that must agree:
`FEATURE_CATALOG` in `speeks.js` and `FB_LISTER_DEF` in the edge function.

Sign-in uses the person's SPEEKSNET PIN, checked on the server. The extension
then holds a signed 30-day token. Changing someone's PIN or deleting them cuts
it off on the next call.

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
