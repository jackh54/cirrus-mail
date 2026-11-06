# Setting up Cirrus Mail

This guide takes you from nothing to a working mailbox on your own domain. It takes about 20 minutes, most of it waiting for DNS.

- [1. Prerequisites](#1-prerequisites)
- [2. Onboard your domain to Email Sending](#2-onboard-your-domain-to-email-sending)
- [3. Enable Email Routing](#3-enable-email-routing)
- [4. Deploy](#4-deploy) (option A: button, option B: CLI)
- [5. Give the web app a custom domain](#5-give-the-web-app-a-custom-domain)
- [6. First-run setup](#6-first-run-setup)
- [7. Add your domain and mailboxes](#7-add-your-domain-and-mailboxes)
- [8. Route all mail to the Worker (catch-all)](#8-route-all-mail-to-the-worker-catch-all)
- [9. Verify DNS](#9-verify-dns)
- [10. Send a test email both ways](#10-send-a-test-email-both-ways)
- [Optional features](#optional-features): AI triage, app passwords and sync, JMAP, Gmail import, PGP, passkeys
- [Upgrading](#upgrading) · [Backups](#backups) · [Troubleshooting](#troubleshooting)

---

## 1. Prerequisites

| You need | Why |
|---|---|
| A Cloudflare account on **Workers Paid** | Email Sending is only available on Workers Paid. |
| A domain whose DNS is on Cloudflare | Email Routing and Email Sending both manage DNS records on the zone. |
| Node.js 22+ and git | Only for the CLI deploy (option B). |

Use the domain's **apex** (for example `example.com`) for mail. Catch-all routing, which Cirrus relies on, works on apex domains only.

If the domain already receives mail somewhere else (Google Workspace, Fastmail, etc.), enabling Email Routing replaces those MX records. Move your mail over deliberately, or try Cirrus on a spare domain first.

## 2. Onboard your domain to Email Sending

Outbound mail goes through Cloudflare Email Service. Your domain has to be onboarded before Cirrus can send from it.

1. In the Cloudflare dashboard, go to **Compute & AI → Email Service**.
2. Choose **Email Sending** and onboard your domain.
3. Cloudflare adds the records it needs to your zone:
   - an **SPF** record
   - a **DKIM** record
   - a `cf-bounce` **MX** record for bounce handling
4. Wait until the domain shows as verified.

Also add a **DMARC** record. It is not required, but receivers trust mail more when it is present. A gentle starting policy:

```
Type: TXT   Name: _dmarc   Content: v=DMARC1; p=none; rua=mailto:you@example.com
```

Move to `p=quarantine` once you have seen a few days of passing reports.

## 3. Enable Email Routing

Inbound mail arrives through Email Routing.

1. In the dashboard, go to **Compute & AI → Email Service → Email Routing**.
2. Enable it and let Cloudflare add its MX and SPF records.

Don't create the catch-all rule yet. The Worker has to exist first; you'll do that in [step 8](#8-route-all-mail-to-the-worker-catch-all).

## 4. Deploy

You need two secrets for either option:

| Secret | What it is |
|---|---|
| `SETUP_TOKEN` | A one-time token you type on the first-run screen to create the admin account. Any long random string. |
| `APP_SECRET` | 32+ random characters, used to sign attachment and image-proxy URLs. |

Generate them with:

```sh
openssl rand -base64 32
```

Keep `SETUP_TOKEN` somewhere safe until you finish [step 6](#6-first-run-setup).

### Option A: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jackh54/cirrus-mail)

1. Click the button and sign in to Cloudflare.
2. Connect your GitHub or GitLab account. Cloudflare creates a copy of the repository there and builds from it.
3. The D1 database and R2 bucket are provisioned automatically. Keep the default names or pick your own.
4. When prompted, enter `SETUP_TOKEN` and `APP_SECRET`.
5. Deploy. When it finishes, you get a `*.workers.dev` URL.

### Option B: CLI

```sh
git clone https://github.com/jackh54/cirrus-mail.git
cd cirrus-mail
npm ci
npx wrangler login
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put APP_SECRET
npm run deploy
```

If the Worker does not exist yet, `wrangler secret put` offers to create it. Say yes.

`npm run deploy` does four things in order:

1. runs the checks (typecheck and tests)
2. builds the web client
3. applies D1 migrations to the remote database, so new code never runs against an old schema
4. deploys the Worker with `wrangler deploy`, then re-runs migrations (a no-op unless this is the first deploy)

On the first deploy, Wrangler provisions the D1 database and R2 bucket named in `wrangler.jsonc`. Step 3 is skipped that time because the database doesn't exist yet, and the migrations run right after the deploy instead. If you have more than one Cloudflare account, set `CLOUDFLARE_ACCOUNT_ID` first.

## 5. Give the web app a custom domain

The `workers.dev` URL works, but a custom domain such as `mail.example.com` is nicer and is what you'll bookmark.

**Dashboard:** Workers & Pages → `cirrus-mail` → Settings → Domains & Routes → Add → Custom domain → `mail.example.com`.

**Or in `wrangler.jsonc`** (CLI deploys):

```jsonc
"routes": [{ "pattern": "mail.example.com", "custom_domain": true }]
```

Pick one method and stick with it, so a later `wrangler deploy` doesn't fight the dashboard.

A subdomain for the web app is fine. Only the mail domain itself needs to be an apex.

## 6. First-run setup

1. Open `https://mail.example.com/setup` (or your `workers.dev` URL).
2. Enter your `SETUP_TOKEN`, your name, the email you'll sign in with, and a password.
3. That creates the first admin account and signs you in.

Setup only works while there are no users, so the screen is closed for good once you finish. You can rotate `SETUP_TOKEN` afterwards if you like.

Turn on two-factor authentication now: **Settings → Security → Two-factor authentication**. Save the recovery codes somewhere safe.

## 7. Add your domain and mailboxes

In **Admin**:

1. **Domains → Add domain:** enter `example.com`.
2. **Mailboxes → New mailbox:** for example `you@example.com`. Add yourself as the owner.
3. Optional:
   - **Aliases**, such as `hello@` delivering into `you@`
   - a **catch-all mailbox** on the domain, for mail to addresses that don't exist
   - **shared mailboxes**, such as `support@`, with several members

Mail to an address that matches no mailbox, alias or catch-all is rejected with `550 5.1.1 No such user`.

### Invite your team

In **Admin → Users**, click **Invite user**. Enter their name, the email they'll sign in with, and optionally a new mailbox for them (for example `sam@example.com`). You can also add them to existing mailboxes, such as a shared `support@` and `help@`, as an owner or member of each. Cirrus creates the account and emails them a link to choose their password.

- Use a sign-in email they can **already read**, such as their personal or work address. An address on a domain Cirrus hosts can't receive the invite before the account exists, so Cirrus shows you the link to share yourself instead.
- The email is sent from your own mailbox (or `noreply@` your domain if you have none), so finish step 2 (Email Sending) first. If sending fails, the invite still exists and you can copy the link.
- Links work once and expire after 7 days. **Resend invite** issues a new link and cancels the old one. Deleting the user revokes the invite.
- Prefer to set a password yourself? **Set a password instead** in the same dialog creates the user with a temporary password they must change on first sign-in.

## 8. Route all mail to the Worker (catch-all)

This tells Email Routing to hand every message for the domain to Cirrus. Cirrus then decides which mailbox it belongs to.

**Dashboard:** **Compute & AI → Email Service → Email Routing → Routing rules → Catch-all address** → edit → action **Send to a Worker** → destination `cirrus-mail` → save, and make sure it is enabled.

**Or in `wrangler.jsonc`** (CLI deploys): add a top-level `addresses` list, and `wrangler deploy` reconciles the routing for you:

```jsonc
"addresses": ["*@example.com"]
```

Catch-all works on apex domains only, so `*@example.com` is valid and `*@mail.example.com` is not.

Deploys only manage rules that point at this Worker, so existing forwarding rules (for example `security@` → your personal inbox) are left alone. Specific address rules always beat the catch-all. Note that `wrangler email routing rules update <domain> catch-all` only accepts `forward` or `drop`, so use the dashboard or `addresses` to send the catch-all to the Worker.

## 9. Verify DNS

Go to **Admin → Domains** and run the **DNS check** on your domain. It checks that:

- MX points at Cloudflare Email Routing
- SPF includes Cloudflare
- a DMARC record is present

Anything red comes with a hint. DNS changes can take a few minutes to show up.

## 10. Send a test email both ways

1. **Inbound:** from a personal account elsewhere (Gmail, iCloud, Outlook), send a message to `you@example.com`. It should appear in your Cirrus inbox within seconds. New mail is picked up every 30 seconds while the tab is open, or straight away if you refresh.
2. **Outbound:** reply from Cirrus. Check it arrives, and open the message source on the receiving side. You want `spf=pass`, `dkim=pass` and `dmarc=pass` in `Authentication-Results`.

You're done. Install the web app from your browser's menu if you want it on your phone's home screen.

---

## Optional features

### Turn on AI triage (admin)

AI triage is off by default. It adds inbox tabs (Primary, Updates, Promotions, Social, Forums) and a Summarise button.

1. Go to **Admin → Overview → AI** and switch it on. The switch is available once the Worker has its Workers AI binding.
2. Set the daily budget (default 500 model calls a day).
3. Each user can hide the tabs in **Settings → Appearance → Inbox tabs**.

When it's on, the start of new inbox mail (about 1,500 characters, plus From and Subject) and any conversation someone summarises goes to Workers AI on your own Cloudflare account, and Cloudflare bills per use. Free header and sender rules run first, so the model runs only when those are unsure. If AI fails or the budget runs out, mail is still delivered.

### Create an app password and sync calendars and contacts

Sync apps never use your account password. They use an app password.

1. Go to **Settings → Security → App passwords** and create one. Enter your account password when asked. The password is shown once, so copy it now.
2. In **Settings → Security → Sync contacts & calendars**, find the server URL and your username (your login email).
3. **iPhone, iPad or Mac:** download the `.mobileconfig` profile from the same section and open it. It sets up CardDAV and CalDAV but contains no password, so your device asks for the app password when it installs.
4. **Android:** use any CardDAV/CalDAV sync app. Add an account with the server URL, your login email and the app password.
5. Other CalDAV and CardDAV clients work with the same URL, email and app password. `/.well-known/caldav` and `/.well-known/carddav` point at `/dav/`.

Changing your account password revokes all your app passwords by default, so create new ones afterwards. You can revoke any app password in the same list.

### Connect a JMAP client

IMAP isn't possible on Cloudflare Workers, so mail apps connect over JMAP.

1. Create an app password as above.
2. In a JMAP-capable client, set the server to `https://mail.example.com` (the session URL is `/.well-known/jmap`). Sign in with your login email and the app password, or use the app password as a bearer token.
3. Each mailbox you belong to shows up as an account. Folders and labels both appear as mailboxes.

Browser-based JMAP clients need their origin allowed first: an admin sets the `jmap_cors_origins` setting to a comma-separated list of exact origins. Native apps don't need this. JMAP hasn't been tested with a real client yet, so expect rough edges.

### Import from Gmail with Google Takeout

1. At takeout.google.com, export only **Mail**, choose the `.mbox` format, and download the archive. Unzip it to get the `.mbox` file.
2. In Cirrus, open **Settings → Mailbox → Import mail** and choose the file. Pick a fallback folder (the default is Archive) and whether to mark everything read.
3. The file uploads in parts. If your connection drops, reload and choose the same file again to resume.
4. Import then runs in the background and can take many minutes for a large archive. Progress shows on the same screen.

Gmail labels become Cirrus labels. Trash, Spam and Sent go to their folders, starred mail keeps its star, and drafts are skipped. Importing again is safe, because duplicates are skipped. Apple Mail and Thunderbird mbox files import too, into the fallback folder. **Export mail** in the same section downloads a mailbox, folder or label as `.mbox` (5 exports per user per hour).

### Set up a PGP key

PGP runs in your browser. The server never sees your passphrase or an unencrypted private key.

1. Open **Settings → Security → Encryption (PGP)**, then generate a key or import one, and choose a PGP passphrase. It's separate from your login password, and nobody can recover it for you.
2. Unlock the key when you want to read encrypted mail. **Lock now**, a reload or signing out locks it again.
3. Add other people's public keys to your keyring by importing them. Cirrus also picks up keys from trustworthy Autocrypt headers on incoming mail, and can look up a key by address. If a key changes, Cirrus asks you to accept it and never swaps it silently.
4. In compose, turn on Encrypt or Sign. Encrypted mail is plain text only, and attachments are blocked while either is on.

Drafts are saved in plain text on the server while you write, and are replaced by the encrypted version when you send. Encrypted mail isn't searchable.

**WKD:** Cirrus can look up other people's keys through Web Key Directory, but it can't publish your key for you. To let others find your key by your address, host your public key yourself at `https://openpgpkey.example.com/.well-known/openpgpkey/example.com/hu/<hash>` or `https://example.com/.well-known/openpgpkey/hu/<hash>`, where `<hash>` comes from your address with `gpg --list-keys --with-wkd-hash`.

### Add a passkey

1. Go to **Settings → Security → Passkeys** and choose **Add**. Enter your password when asked.
2. Follow your browser or device prompt, and give the passkey a name.
3. On the sign-in page, choose **Sign in with a passkey**. If you also use 2FA, you can choose **Use a passkey instead** of typing the code.

The section is hidden when your browser doesn't support passkeys. Passkeys are tied to the domain you serve Cirrus from, so changing the domain means you sign in with your password again. You can have up to 20.

---

## Upgrading

**CLI deploys:**

```sh
git pull && npm run deploy
```

`npm run deploy` applies any new D1 migrations, then deploys the new Worker. Read the release notes first: they call out anything that needs a manual step.

**Button deploys:** your copy of the repository is yours. Merge changes from `jackh54/cirrus-mail` into it and push; Cloudflare rebuilds and redeploys from your repository.

## Backups

Your mail lives in two places, so back up both.

**D1 (metadata, threads, search index):**

```sh
npx wrangler d1 export cirrus-mail --remote --output=cirrus-$(date +%F).sql
```

D1 also keeps point-in-time history (Time Travel), which you can restore with `npx wrangler d1 time-travel`. Treat that as a safety net, not your only backup.

**R2 (raw messages, bodies, attachments):** R2 has an S3-compatible API, so any S3 tool can copy the bucket. For example, with [rclone](https://rclone.org/) configured for R2:

```sh
rclone sync r2:cirrus-mail ./cirrus-r2-backup
```

Create an R2 API token with read access for this in the dashboard (R2 → Manage R2 API Tokens).

Every message's original `.eml` is kept in R2 under `raw/`. Even without D1 you can always recover the mail itself.

## Troubleshooting

### Mail is not arriving

Work through these in order:

1. **Email Routing enabled?** Its MX records must be the only MX records for the domain (apart from the `cf-bounce` MX that Email Sending adds).
2. **Catch-all rule set?** It must point at the `cirrus-mail` Worker and be enabled ([step 8](#8-route-all-mail-to-the-worker-catch-all)).
3. **Domain and mailbox added in Admin?** Without them, Cirrus rejects the message with `550 5.1.1 No such user`, and the sender gets a bounce.
4. **Message too big?** Anything over 25 MiB is rejected.
5. **Check the Email Routing activity log** in the dashboard. It shows whether the message reached the Worker, and whether it was rejected.
6. **Look in Spam.** Messages that fail DMARC score high.

### `E_SENDER_NOT_VERIFIED`

The From address's domain isn't onboarded to Email Sending, or verification hasn't finished. Go back to [step 2](#2-onboard-your-domain-to-email-sending), and check the SPF and DKIM records it added are still in your DNS.

### Daily limit reached (`E_DAILY_LIMIT_EXCEEDED`)

Each Cloudflare account has a daily sending quota, which starts conservative and grows as you send good mail. Enter yours in **Admin → Overview → Sending** (find it under Email Service → Email Sending in the dashboard), and Cirrus shows today's usage and warns everyone once 80% is used. Cirrus counts per recipient per UTC day, including invites and auto-replies. When Cloudflare refuses a send, Cirrus keeps the message in Drafts and tells you. Try again the next day, or schedule it. `E_RATE_LIMIT_EXCEEDED` means you sent too many messages in a short burst; wait a minute and retry.

### My sent mail lands in the recipient's spam folder

- Add a DMARC record if you haven't ([step 2](#2-onboard-your-domain-to-email-sending)).
- Check the received message shows `spf=pass`, `dkim=pass` and `dmarc=pass`.
- New domains have no reputation yet. Send normal, personal mail to people who expect it, and it improves.
- Ask recipients to mark your mail as "not spam" and add you to their contacts.

### Good mail lands in my Cirrus spam folder

Open it and choose **Not spam**. Messages from people in your contacts are never marked as spam, and Cirrus adds people to your contacts automatically when you write to them.

### I lost my password or 2FA device

Enter one of your recovery codes in place of the 2FA code when you sign in. If you are not the only admin, another admin can reset your password in **Admin → Users**.
