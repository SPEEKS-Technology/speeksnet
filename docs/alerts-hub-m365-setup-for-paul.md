# Letting SPEEKSNET read one mailbox (read-only)

**For:** Paul (Microsoft 365 admin for speekstechnology.com)
**Time:** about 15 minutes
**You need:** to sign in with a **Global Admin** or **Exchange Admin** account

---

## Why we're doing this

SPEEKSNET's **Alerts Hub** sends urgent emails to Ethan's phone as push alerts:
mail from you, from @paymore.com senders and from store managers. To do that it
has to be able to **read** Ethan's work mailbox.

What this setup gives SPEEKSNET:

- **One mailbox only:** `ethan.kushnir@speekstechnology.com`. No other mailbox in the company.
- **Read-only.** It can't send, delete, move or change anything.
- **You can switch it off any time.** Deleting the app (Part 5) cuts access at once.

> **Words you'll see**
> - **App registration**: an "ID card" for SPEEKSNET inside your Microsoft 365, so Microsoft knows who's asking.
> - **Client secret**: the password that goes with that ID card. Treat it like a password.
> - **PowerShell**: the blue command window that comes with Windows. You'll paste five commands into it.

---

## Part 1: Create the app's ID card (about 3 minutes)

1. Go to **https://entra.microsoft.com** and sign in with your admin account.
2. In the left menu, click **Entra ID**, then **App registrations**.
   (On older screens this is **Identity → Applications → App registrations**.)
3. Click **+ New registration** at the top.
4. Fill it in:
   - **Name:** `SPEEKSNET Mail Alerts`
   - **Supported account types:** pick **Accounts in this organizational directory only** (single tenant).
   - **Redirect URI:** leave it blank.
5. Click **Register**.
6. You're now on the app's **Overview** page. Copy these two values into a note.
   They are **not** secret, so it's fine to send them to Ethan:
   - **Application (client) ID**
   - **Directory (tenant) ID**

## Part 2: Create the password (client secret) (about 3 minutes)

1. Still on the app's page, click **Certificates & secrets** in the left menu.
2. Click **+ New client secret**.
3. **Description:** `SPEEKSNET`. **Expires:** **24 months**. Click **Add**.
4. **Copy the Value right away.** It's shown only once; if you leave the page it's hidden forever
   (if that happens, just delete it and make a new one).
   Copy the **Value** column, not the "Secret ID" column.

> ⚠️ **Do not email, text or chat this value to anyone, Ethan included.**
> Put it straight into SPEEKSNET's server settings yourself (next part).

## Part 3: Put the three values into SPEEKSNET (about 2 minutes)

1. Go to **https://supabase.com/dashboard** and open the project **SPEEKSNET BACKEND**.
2. In the left menu click **Edge Functions**, then **Secrets**.
3. Add these three, one at a time (name on the left, value on the right), then **Save**:

   | Name | Value |
   |---|---|
   | `MS_TENANT_ID` | the Directory (tenant) ID from Part 1 |
   | `MS_CLIENT_ID` | the Application (client) ID from Part 1 |
   | `MS_CLIENT_SECRET` | the secret Value from Part 2 |

**No Supabase login?** Get on a quick call (or sit together) with Ethan. Ethan opens the
Secrets page on their own screen and you type the secret Value into it yourself, or read it
out loud for Ethan to type. Either way the secret never goes into an email, text, chat or
document.

## Part 4: Give it read access to that ONE mailbox only (about 7 minutes)

> ⚠️ **Important: do NOT click "API permissions" → "Add a permission" → Mail.Read in the portal.**
> That grants SPEEKSNET **every mailbox in the company**. The steps below limit it to
> Ethan's mailbox alone.

### 4a. Find one more number: the Object ID

This one lives on a **different page** from Part 1, and the two IDs look alike, so go slowly here.

1. Back at **https://entra.microsoft.com**, left menu: **Entra ID → Enterprise apps**
   (older screens: **Identity → Applications → Enterprise applications**).
2. If you don't see it, clear the "Application type" filter, then search **SPEEKSNET Mail Alerts** and click it.
3. On its **Overview** page, copy the **Object ID**.

> ✋ Use the Object ID from **Enterprise apps**, **not** the "Object ID" shown on the App
> registrations page. They're different numbers, and the wrong one makes step 3 below fail.

### 4b. Run five commands in PowerShell

1. Click **Start**, type **PowerShell**, and open **Windows PowerShell**.
2. Paste each command below, one at a time, and press **Enter**. Where you see
   `<client-id>` or `<object-id>`, swap in your numbers (delete the `< >` too).

**Command 1: install Microsoft's Exchange tool** (one time only; answer **Y** if it asks to trust the source):

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
```

**Command 2: sign in** (a Microsoft sign-in box pops up; use your admin account):

```powershell
Connect-ExchangeOnline
```

**Command 3: tell Exchange about the SPEEKSNET app** (uses the client ID from Part 1 and the Object ID from 4a):

```powershell
New-ServicePrincipal -AppId <client-id> -ObjectId <object-id> -DisplayName "SPEEKSNET Mail Alerts"
```

**Command 4: make a "fence" around Ethan's mailbox only:**

```powershell
New-ManagementScope -Name "SPEEKSNET Alerts Mailboxes" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'ethan.kushnir@speekstechnology.com'"
```

**Command 5: give the app read-only mail access inside that fence:**

```powershell
New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Read" -CustomResourceScope "SPEEKSNET Alerts Mailboxes"
```

**Optional check:** this should list the role with **InScope** = **True**:

```powershell
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource ethan.kushnir@speekstechnology.com
```

Microsoft can take **up to about 2 hours** to switch the access on after Command 5, so if
Ethan says it isn't working yet, that's normal. Give it time.

---

## Part 5: When you're done

**Send Ethan a short message with:**

- the **Application (client) ID**
- the **Directory (tenant) ID**
- "The secret is in Supabase." (Not the secret itself.)

**To switch it off later** (any time, for any reason):

1. **https://entra.microsoft.com** → **Entra ID → App registrations** → **SPEEKSNET Mail Alerts** → **Delete**.
   Access stops right away.
2. Optional tidy-up in PowerShell (after `Connect-ExchangeOnline`). This removes the leftover
   permission and fence; answer **Y** to each prompt:

```powershell
Get-ManagementRoleAssignment -RoleAssignee <client-id> | Remove-ManagementRoleAssignment
```

```powershell
Remove-ManagementScope "SPEEKSNET Alerts Mailboxes"
```

**When the secret expires** (24 months): repeat Part 2 and paste the new Value over
`MS_CLIENT_SECRET` in Supabase. Nothing else changes.
