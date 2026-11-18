# Handoff: SPEEKS Facebook Marketplace Lister

Updated 2026-11-13 (end of day). Repo `speeksnet`, branch
`Main-December-Update-2---Ethan`. Read `CLAUDE.md`, then `tools/fb-lister/README.md`.

## What it is
A Chrome extension (MV3, now **v1.6.0**) that fills a Facebook Marketplace
listing from one of our own Shopify items. It reads only our data, through the
`fb-lister` edge function. A person checks everything and clicks **Publish**.
The extension never clicks Publish, Post or Mark as sold. The one exception is
**Next**, clicked once, only when the person presses the panel's
**Confirm & Next** (Ethan asked for this 11-13). Users download it from SPEEKS
Tools → **Downloads**.

## State right now
- **Commit:** all work is committed in `9281336` (on top of `3f25446` and the
  five earlier Lister commits). **Nothing is pushed.** The branch has 9
  commits not on origin. Two of them are not Lister work: `f2b4660` (Live
  Dashboard) and `c5e11db` (Claims). Push only with Ethan's OK. They need a
  merge to main before speeksnet.com shows the site changes.
- **Live in prod:**
  - `fb-lister` v10 (thumbs + live stock, refresh times, shared Listed list,
    learned category).
  - Migrations 0181 (catalog refresh hourly, 9am–8pm CT), 0182
    (`fb_listings`) and 0183 (boost columns) are applied.
- **NOT live yet. Ethan's go-ahead was pending, so ask first:**
  1. Deploy `fb-lister` again (its `boost` action came after v10):
     `npx supabase functions deploy fb-lister --no-verify-jwt --project-ref ejzaqmyxxrkmxvzbjeuo --yes`
  2. Deploy the new `fb-boost-report` function (`--no-verify-jwt`; it checks
     `?secret=` itself).
  3. Deploy `email-recipients`, which now allows the list key `fb_boosts`.
     **Byte-compare the deployed copy to the repo first.** Deployed functions
     sometimes have changes the repo lacks.
  4. Add a cron job for Monday 8:30am Central (with the Weekly Report; drafted
     as `0184_fb_boost_report_cron.sql`, also seeds Ethan + Paul) as a new migration (next free
     number is **0184**; check `list_migrations` and the other branches
     first). Use the hourly-with-Chicago-hour-guard pattern from
     `0153_unrestocked_returns.sql`, restricted to Mondays, hitting
     `fb-boost-report?secret=...`. Add a `cron_expectations` row like 0153
     does.
- The extension zip at `tools/fb-lister/SPEEKS-Marketplace-Lister.zip` is
  built at 1.6.0. Testers load `tools/fb-lister/extension` unpacked and click ↻.

## How it works now (beyond the README)
- **Popup:**
  - In-stock list: newest first, lead photos. Rows Shopify says are sold are
    dropped live through `thumbs`.
  - "List Updated · Next" line, from `ebay_catalog_runs` plus
    `REFRESH_HOURS_CT` in fb-lister. **Keep that in step with the cron in
    0181.**
  - The store dropdown (DMs only) is a SPEEKSNET-style custom dropdown.
  - Sign-in is in `chrome.storage.session`, so closing Chrome signs the
    person out.
- **Facebook page one:** photos, title, price (checked by digits), learned
  category, condition, description, SKU (under More details).
- **Facebook page two (Delivery method):** location set to the store's city,
  Public meetup on, door pickup and dropoff off. This runs after Confirm &
  Next or after Facebook's own Next. Fill Again fills whichever page you're
  on. Then groups are ticked (only groups the person has joined; "Your
  Rules" is parked).
- **Listed tab = the store's list** (`fb_listings`):
  - A row is written only after the person's Publish goes through.
  - Remove and Marked Sold ask for confirmation first.
  - **Mark Boosted** records days and total budget (`boosted_at`,
    `boost_days`, `boost_budget`, `boost_ends_at`, `boosted_by`).
  - Names come from the verified token, so they can be trusted.
- **Category learning:** saved at Confirm & Next, keyed by the item's
  Shopify collection (`kind`). The most-picked category for that kind is
  auto-picked next time.
- **Weekly email `fb-boost-report`** ("Facebook Boosts"):
  - Content: three tiles (Boosted This Week, Boosts Started, Running Now
    with "N Ending in 3 Days") and a By Store table (Open Boosts, Boosted
    Amount).
  - Ethan cut the item lists and anything about sold. Keep it that way.
  - Recipients: list `fb_boosts`, falling back to `claims_disputes_dm`.
  - Preview without deploying:
    `node scripts/fb-boost-email-preview.mts scripts/fb-boost-email-preview.html`
  - Live preview once deployed: `?secret=...&html=1`. Test send:
    `&to=address`.

## Verifying
- Mocks (serve the repo on :8080 via the `speeksnet` preview):
  - `scripts/fb-lister-fill-mock.html`: the full run. `?fbnext` makes the
    person click Facebook's Next instead. `?sold` covers the Selling page.
  - `scripts/fb-lister-popup-mock.html`: `?signin` for the sign-in screen,
    `?gone` for a sold row dropping.
- **Real Facebook has not been re-tested since 1.5.x.** Page two's field
  names (Location box, "Door dropoff") come from Ethan's screenshots. If a
  panel row shows ×, ask for a screenshot and fix the field finder in
  `content.js`.

## Ethan's standing decisions
- **Visibility:** Downloads shows for every role. The Lister inside it shows
  for DMs only by default; switch others on in Feature Access (`fb-lister`).
- **Stores:** each person sees only their own store; CORP sees all five.
- **Labels:** Title Case. Keep panel text short: no reasons on group picks,
  no list of unticked groups, no wording on a Public Meetup ✓, "Pick It
  Yourself".
- **Look:** SPEEKSNET's colours only. Pills in a row are the same size.
  Popup corners can't be rounded (Chrome draws the frame).
- **No More Details filling:** the whole listing is in the description.
- **No boost toggle in the panel:** boosts are recorded with Mark Boosted.
- **Ask before:** any prod deploy, and before pushing.
