# Expiring Credentials — inventory and how the alert works

Written 2026-11-21. The alert is the `credential-expiry` edge function, run daily at
7:50am Central (cron `credential-expiry-750am`, migration `0196`). It reads
`public.credential_expiry` and emails the **Expiring Credentials** list (Email
Recipients → System Alerts) at **60, 30, 14, 7 and 1 days** before a date, then
**every day once it has expired**. Each email says how to renew. If the list is empty
the email goes to Ethan.

## What is watched (rows in `credential_expiry`)

| Credential | Expires | Where the date comes from | How to renew |
|---|---|---|---|
| **Microsoft Entra client secret** `MS_CLIENT_SECRET` (app "SPEEKSNET Mail Alerts", client ID 286a48f2-0c82-4076-bc13-dddf07824e69) | **2028-11-21** | Created 2026-11-21 with a 24-month lifetime (entered by hand) | entra.microsoft.com → Entra ID → App registrations → SPEEKSNET Mail Alerts → Certificates & secrets → New client secret. Paste the value over `MS_CLIENT_SECRET` in Supabase → Edge Functions → Secrets. Then delete the old secret and update the row's date. |
| **eBay refresh token, OVL** | 2028-03-24 | **Automatic**: `ebay_stores.refresh_token_expires_at`, which eBay sets each time the store is reconnected | Open `…/functions/v1/ebay-oauth?store=OVL&secret=<ops secret>` and sign in with that store's eBay account. The new date updates itself. |
| eBay refresh token, LEE | 2028-03-24 | Automatic | Same, `store=LEE` |
| eBay refresh token, WSP | 2028-03-24 | Automatic | Same, `store=WSP` |
| eBay refresh token, BAL | 2028-03-24 | Automatic | Same, `store=BAL` |
| eBay refresh token, MPL | 2028-05-14 | Automatic | Same, `store=MPL` |
| **speeksnet.com domain registration** | **unknown, needs a date** | Registrar | Renew at the registrar (or check auto-renew and the card on file). |
| **Supabase CLI access token** (Ethan's PC, used for deploys only) | **unknown, needs a date** | supabase.com/dashboard/account/tokens | `npx supabase login` again. If the token has no expiry, mark the row inactive. |

The two rows with no date never send an alert on their own, but every alert lists
them at the bottom so they don't get forgotten.

### Entering or changing a date by hand

There's no screen for this yet. Ask Claude to do it, or run this SQL in Supabase:

```sql
update credential_expiry set expires_at = '2027-08-14', updated_at = now()
 where key = 'domain_speeksnet';
```

Renewing a credential means moving its date. Moving the date resets the warning
stages automatically, so nothing else needs touching. To stop watching a row, set
`active = false`. To send one row's alerts to a different list, set `notify_list` to
another Email Recipients list key. Add the key to the email-recipients function's
`LIST_KEYS` too, or the panel can't edit it.

## Checked and left out: these don't expire

| Credential | Where | Why it isn't watched |
|---|---|---|
| Shopify Admin API tokens, 5 stores (`shopify_stores.access_token`) | shopify-oauth | Offline tokens with no expiry date. They only stop working if the app is uninstalled or the token is revoked. |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` / `SHOPIFY_APPS` | Shopify Dev Dashboard | App credentials, no expiry. They change only if someone rotates them, and `SHOPIFY_CLIENT_SECRET_PREV` is there to cover a rotation. |
| `EBAY_APPS` (app keysets), `EBAY_VERIFICATION_TOKEN`, `EBAY_NOTIFY_URL` | eBay Developer | No expiry. The keyset can be switched off if the account-deletion endpoint stops answering. The 1-hour eBay access tokens refresh themselves (`ebay_stores.access_token_expires_at`). |
| `ANTHROPIC_API_KEY` | console.anthropic.com | No expiry. It stops if it's revoked or billing lapses. |
| `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` | Dev Tracker GitHub App | A GitHub App's private key and webhook secret don't expire. The 1-hour installation tokens are made from the key. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_JWK` | Alerts Hub web push | Self-generated key pair, no expiry. |
| `MS_CLIENT_ID` / `MS_TENANT_ID` | Entra | IDs, not secrets. Only the client secret above expires. |
| `SPEEKS_MCP_KEY` | the claude.ai SPEEKSNET connector | Our own random key, no expiry. |
| Supabase anon key (in `speeks.js`) | Supabase | The JWT's own `exp` is 2096. `SUPABASE_SERVICE_ROLE_KEY` and the other `SUPABASE_*` secrets are managed by Supabase. |
| Ops/sync secret (`sp33ks-sync-k3y-…`), `SYNC_SECRET` | Edge functions + Apps Scripts | Our own shared string, no expiry. |
| Gmail relay, Sales import, Month rollover and Buy/Sell history Apps Script web apps (`GMAIL_RELAY_URL`, `SALES_IMPORT_URL`, `MONTH_ROLLOVER_URL`, `BUYSELL_HISTORY_URL`) | Google Apps Script | Deployments don't expire. A Google password change or a revoked grant can stop them. That would show up as failed sends, not on a date. |
| HTTPS certificate for speeksnet.com | GitHub Pages | Let's Encrypt, renewed by GitHub automatically. |
| `RESEND_API_KEY` | weekly-report / usage-report fallback | Not set in Supabase, so that code path is unused. |

## Testing the function

```
…/functions/v1/credential-expiry?secret=<ops>&list=1               rows + days left
…/functions/v1/credential-expiry?secret=<ops>&dryRun=1             what would send today (sends nothing)
…/functions/v1/credential-expiry?secret=<ops>&test=1&to=<addr>     a sample of every dated row to one address
```

A send with `to=` doesn't record the stage, so the real list still gets its warning.
