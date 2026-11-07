# FAQ

- [What does it cost?](#what-does-it-cost)
- [What are the limits?](#what-are-the-limits)
- [Who can read my mail?](#who-can-read-my-mail)
- [Is this allowed? (acceptable use)](#is-this-allowed-acceptable-use)
- [Can I use IMAP, Apple Mail, Outlook or Thunderbird?](#can-i-use-imap-apple-mail-outlook-or-thunderbird)
- [Does it use SMTP?](#does-it-use-smtp)
- [Can I use more than one domain?](#can-i-use-more-than-one-domain)
- [Can several people share a mailbox?](#can-several-people-share-a-mailbox)
- [Can I import my old mail?](#can-i-import-my-old-mail)
- [Is there a native app?](#is-there-a-native-app)
- [Does the AI feature send my mail anywhere?](#does-the-ai-feature-send-my-mail-anywhere)

## What does it cost?

Cirrus itself is free and MIT-licensed. You pay Cloudflare for what you use on your own account:

| Item | Cost |
|---|---|
| Workers Paid plan | $5/month. Required for Email Sending. |
| Outbound mail (Email Sending) | 3,000 emails/month included per account (aligned with your billing cycle), then $0.35 per 1,000. Sends to verified destination addresses on your own account are free. |
| Inbound mail (Email Routing) | Free |
| D1 and R2 | Usage-based. A typical small team stays within the included tiers. |

Prices change, so check Cloudflare's pricing pages before you rely on these numbers.

## What are the limits?

- **50 recipients** per message (To + Cc + Bcc combined).
- **25 MiB** per message including attachments, in either direction.
- A **daily sending quota** per Cloudflare account, which grows as you send good mail (for example 1,000 a day). Cloudflare doesn't expose it to Workers, so enter it in **Admin → Overview → Sending**: Cirrus then shows today's usage and warns you at 80%. It never blocks a send itself. If Cloudflare refuses one, Cirrus keeps the message in Drafts and tells you.
- **Email Sending is in beta.** It has been in public beta since 2026-04-16, so expect changes.
- Catch-all routing works on **apex domains only** (`example.com`, not `mail.example.com`).

## Who can read my mail?

Your mail is stored in your own Cloudflare account: metadata and the search index in D1, and raw messages, bodies and attachments in R2. There is no Cirrus server, no telemetry and no third-party service.

What Cirrus does for privacy:

- Invocation logs are turned off, and the app never logs message content.
- Remote images in mail are blocked by default. When you load them, they're fetched through your own Worker, so senders don't see your IP address or exactly when you opened the message.
- HTML mail is sanitized and rendered in a sandboxed frame with no scripts.

What it doesn't do: mail is not end-to-end encrypted by default. Like any email provider, your Cloudflare account processes and stores the messages, and Cloudflare's own terms and privacy policy apply. Anyone with admin access to that Cloudflare account can reach the data. Protect it with strong credentials, 2FA or passkeys.

PGP is available if you want end-to-end encryption. Encryption, signing and decryption happen in your browser, and the server stores only your public key and a private key that your PGP passphrase has already encrypted. Limits: drafts sit on the server as plain text until you press Send, attachments can't be encrypted or signed, encrypted mail is plain text only and can't be searched, and subject and recipients stay visible, as in any PGP mail. Cirrus can't publish your key over Web Key Directory yet.

## Is this allowed? (acceptable use)

Read this one carefully.

Cloudflare documents Email Sending as being for **transactional email**. Its documentation doesn't explicitly address person-to-person mail sent from your own mailbox, which is what Cirrus does.

Cirrus has no bulk mail, mailing lists, campaigns or marketing features, and it never will. It sends one message at a time, written by a person, to at most 50 recipients.

Whether your use fits is between you and Cloudflare. Review Cloudflare's terms for your situation before you depend on it, especially for business mail.

## Can I use IMAP, Apple Mail, Outlook or Thunderbird?

Not over IMAP, and that can't change inside Cirrus. IMAP needs a server that accepts inbound TCP connections, and Cloudflare Workers can't do that. Cirrus has a JMAP server instead, which runs over HTTPS. Mail apps that speak JMAP can connect with your login email and an app password (see the [setup guide](setup.md#connect-a-jmap-client)). JMAP hasn't been tested with a real client yet. Apps that only speak IMAP can't connect. Use the web app, which you can install to your home screen as a PWA, or a JMAP-capable app.

Calendars and contacts do sync with Apple and Android devices over CalDAV and CardDAV, using app passwords. An optional IMAP bridge that you run somewhere else is on the roadmap.

## Does it use SMTP?

No. Cloudflare offers SMTP submission (in beta), but Cirrus sends through the Worker's `send_email` binding instead, and receives through Email Routing. Nothing in Cirrus needs an SMTP server.

## Can I use more than one domain?

Yes. Add each domain in **Admin → Domains**, and for each one:

1. onboard it to Email Sending
2. enable Email Routing
3. add a catch-all rule that sends to the `cirrus-mail` Worker

Each domain can have its own mailboxes, aliases and catch-all mailbox. All of them need to be apex domains on your Cloudflare account. The [setup guide](setup.md) covers each step.

## Can several people share a mailbox?

Yes. In **Admin → Mailboxes**, add several users as members of a mailbox such as `support@example.com`. Each member sees it in their mailbox switcher and can read and send from it.

Aliases (for example `hello@` delivering into `you@`) are separate: they're extra addresses for one mailbox, and you can send from them too.

## Can I import my old mail?

Yes, from an mbox file. Export your Gmail with Google Takeout, or export from Apple Mail or Thunderbird, then use **Settings → Mailbox → Import mail**. Gmail labels, stars and read state carry over, and drafts are skipped. Importing the same file twice doesn't create duplicates. Large archives import slowly in the background. The [setup guide](setup.md#import-from-gmail-with-google-takeout) has the steps. You can also export a mailbox, folder or label back to mbox. There is no live sync from other providers.

## Is there a native app?

Yes, for iPhone: the iOS app is in public beta. [Join it on TestFlight](https://testflight.apple.com/join/u5zScSGa) (iOS 26 or later) and sign in with your server address, your email and an app password from **Settings → Security**. There's no Android app yet; use the web app as a PWA, or connect a JMAP client.

## Does the AI feature send my mail anywhere?

AI triage is off by default, and only an admin can turn it on. When it's on, the text of new inbox mail (about the first 1,500 characters, plus From and Subject) and of any conversation someone chooses to summarise goes to Workers AI. That runs in the same Cloudflare account as the rest of Cirrus, so nothing goes to another service, and Cloudflare bills you per use. Cirrus never logs message content. Many messages are sorted by free header rules without calling the model. If the feature is off, no message text is sent to Workers AI.
