# Cirrus Mail: design

Status: v0.1 design, 2026-11-05. This is the contract for the initial build. The API section is binding for both the Worker and the client.

## 1. What it is

Cirrus Mail is an open-source email suite you deploy to your own Cloudflare account. Anyone on Workers Paid can run it. One deploy gives a team, family or small company:

- full mailboxes on their own domains, for receiving, sending, threading, search, folders and attachments
- a fast web client that is installable as a PWA, works on mobile and has keyboard shortcuts
- an admin console for users, domains, mailboxes, aliases, catch-alls and shared mailboxes

Everything runs on Cloudflare primitives:

| Concern | Primitive |
|---|---|
| Inbound mail | Email Routing (catch-all, "Send to a Worker") → `email()` handler |
| Outbound mail | Email Service "Email Sending" → `send_email` binding |
| Metadata, search | D1 (SQLite + FTS5) |
| Raw `.eml`, bodies, attachments | R2 |
| Scheduled send, cleanup | Cron trigger (every minute) |
| Web app + API | One Hono Worker that also serves the Vite SPA from static assets |

There are no Durable Objects, no Queues and no third-party services.

## 2. Constraints that shape the design (from Cloudflare docs, Nov 2026)

- Sending requires **Workers Paid**. It includes 3,000 emails a month, then $0.35 per 1,000. Email Routing (inbound) is free and unlimited.
- At most **50 recipients** per message (to + cc + bcc) and **25 MiB** per message including attachments, in either direction. At most 32 attachments.
- `Message-ID` is **set by the platform**: `send()` returns `{ messageId }`, and we store that value. `In-Reply-To` and `References` may be set, so threading works.
- The daily sending quota starts low and grows over time. The UI must surface `E_DAILY_LIMIT_EXCEEDED` and `E_RATE_LIMIT_EXCEEDED` clearly.
- `wrangler dev` **simulates** sends by default. Use `"remote": true` on the binding only when you mean it.
- **Acceptable use:** Cloudflare documents Email Sending as transactional email only. Human-to-human mail from your own mailbox is not explicitly addressed. The README states this plainly. Cirrus has no bulk or marketing features and never will.
- The catch-all (`*@domain`) works on apex domains only.

## 3. Architecture

```
            ┌──────────── Cloudflare account (yours) ─────────────┐
 sender ──► │ Email Routing ─catch-all─► Worker.email()           │
            │                              │ parse (postal-mime)  │
            │                              ├─► R2  raw/, att/     │
            │                              └─► D1  messages, FTS  │
 browser ◄─►│ Worker.fetch()  Hono /api/*  + static SPA           │
            │        │ send ─► env.EMAIL.send() ─► internet        │
            │ Worker.scheduled() (1 min): scheduled sends, purge  │
            └─────────────────────────────────────────────────────┘
```

### 3.1 Inbound pipeline (`src/worker/inbound/`)

1. Buffer `message.raw` exactly once. Reject with `setReject` if `rawSize > 25 MiB`.
2. Resolve each envelope `message.to` in this order: exact mailbox address, then alias, then domain catch-all. If nothing matches, call `setReject("550 5.1.1 No such user")`. Unknown domains are rejected the same way.
3. Parse with `postal-mime`.
4. Store the raw message at `raw/{mailboxId}/{messageId}.eml` in R2. Store `{html,text}` at `body/{mailboxId}/{messageId}.json`. Store each attachment at `att/{mailboxId}/{attachmentId}`.
5. **Threading:** look up `In-Reply-To`, then each `References` id, against `messages.message_id_hdr` in the same mailbox. If that finds nothing, fall back to the normalized subject (strip `re:`/`fwd:`/`aw:` prefixes) plus a shared participant within the last 30 days. Otherwise start a new thread.
6. **Spam verdict** (score 0–10, spam at ≥ 5):
   - Parse `Authentication-Results`: `dmarc=fail` +5, `spf=fail` +2, `dkim=fail` +2.
   - A sender on the mailbox blocklist means spam.
   - A sender in the user's contacts −3 (never spam).
7. **Filters:** user rules run in `sort` order. Conditions match `from`, `to`, `subject`, `has_attachment` or `list_id` using `contains`, `equals`, `ends_with` or `regex` (the pattern is capped at 200 chars and must compile). Actions: `move_to` (folder), `mark_read`, `star`, `delete` (to Trash), `forward_to` (must be a verified Email Routing destination; failures are logged, not fatal).
8. Insert the message, attachments and FTS row, then update thread aggregates, all in one D1 batch.
9. **Auto-reply (vacation):** send only when all of these hold:
   - the mailbox has it enabled and within its date window
   - the sender is not us
   - the message has no `Auto-Submitted`, `List-Id` or `Precedence: bulk|list|junk` header
   - we have not replied to this sender in the last 4 days (`autoreply_log`)
   Sent with `Auto-Submitted: auto-replied`.

### 3.2 Outbound (`src/worker/outbound/`)

- The client composes a draft (stored as a message with `status='draft'`, `folder=Drafts`), then calls `POST /api/messages/:id/send` with an optional `sendAt`.
- The Worker checks that the user may send as the From identity (mailbox address or one of its aliases), and validates recipients (≤ 50) and size (≤ 25 MiB).
- When replying, it sets `In-Reply-To` and `References` from the parent message.
- It loads attachment bytes from R2 and calls `env.EMAIL.send({...})`.
- On success: `status='sent'`, `message_id_hdr = <returned messageId>`, move the message to Sent, upsert contacts.
- On failure: `status='failed'`, `error_code` is stored and the message stays in Drafts. The API returns `{ error: { code, message } }` with a 502 or 429 status.
- `sendAt` in the future sets `status='scheduled'`. The cron claims rows where `send_at <= now AND status='scheduled'` by atomically setting `status='sending'`, then sends them.
- Undo send is done on the client: the client waits 5 s, cancellably, before calling `/send`.

### 3.3 Cron (`scheduled`, every minute)

- Send due scheduled messages (claim pattern, max 25 per tick).
- Once an hour (when `minute == 0`):
  - hard-delete Trash and Spam items older than 30 days (rows plus R2 objects)
  - prune expired sessions, upload stubs and rate-limit rows

### 3.4 Security

- **Passwords:** PBKDF2-SHA256 at 100,000 iterations (the WebCrypto maximum on Workers), 16-byte salt, stored as `pbkdf2$100000$<salt b64>$<hash b64>`. Compare in constant time.
- **Sessions:**
  - 32 random bytes; only SHA-256(token) is stored.
  - Cookie `cirrus_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, sliding 30-day expiry.
- **CSRF:** every non-GET `/api` request must carry the header `X-Cirrus: 1`. The client always sends it, and SameSite=Lax blocks cross-site cookie use on top of that.
- **2FA:** optional TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step), plus 10 one-time recovery codes stored hashed.
- **Login throttling:** `rate_limits` table, at most 10 failures per 15 min per (ip, email). After that, return 429.
- **First-run setup:** `POST /api/setup` works only while there are zero users. It requires `SETUP_TOKEN` (a Worker secret) to match, and it creates the first admin.
- **Authorization:** every mailbox-scoped query joins `mailbox_members` on the session user. Admin routes require `role='admin'`.
- **HTML mail rendering:**
  - Sanitize on the client with DOMPurify (no scripts, forms or event handlers).
  - Render in `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">`, with no `allow-scripts` and no `allow-same-origin`, via `srcdoc`.
  - The `srcdoc` carries a CSP meta: `default-src 'none'; img-src data: <origin>; style-src 'unsafe-inline'; font-src data:`.
- **Remote images** are blocked by default. "Load images" rewrites them through `/api/proxy/image?u=<url>&s=<hmac>`. The HMAC uses `APP_SECRET` so the endpoint is not an open proxy. The proxy fetches only `http(s)` URLs, only `image/*` content types, and at most 5 MB.
- **Attachment and inline-image URLs** are signed: `/api/files/:attachmentId?e=<exp>&s=<hmac>`, valid 1 h. The sandboxed iframe sends no cookies, so the signature is the authorization.
- **Privacy:** `observability.logs.invocation_logs: false`. The app never logs message content.

## 4. Data model

The schema in `migrations/0001_init.sql` is authoritative. In summary:

- `users`, `sessions`, `recovery_codes`
- `domains` (catch-all mailbox), `mailboxes`, `mailbox_members` (owner or member, which gives shared mailboxes), `aliases`
- `folders` (system roles: inbox, sent, drafts, archive, spam, trash, scheduled; plus custom folders)
- `threads`, `messages`, `attachments`, `messages_fts` (FTS5; external content off, keyed by `message_id`)
- `contacts` (per user, auto-collected), `filters`, `blocked_senders`, `autoreply_log`
- `rate_limits`, `settings` (instance key/value)

IDs are text ULIDs; `src/shared/ulid.ts` is the only generator. Timestamps are integer epoch milliseconds.

## 5. HTTP API (binding contract)

- Every response is JSON. Errors use `{ "error": { "code": "SNAKE_CASE", "message": "..." } }` with a suitable status.
- Types live in `src/shared/api.ts`, which both sides import.
- Lists use cursor pagination: `?cursor=&limit=` returns `{ items, nextCursor }`.

### Auth & setup
| Method | Path | Body → Response |
|---|---|---|
| GET | `/api/setup/status` | → `{ needsSetup: boolean }` |
| POST | `/api/setup` | `{ token, name, email, password }` → `{ user }` (and sets the cookie) |
| POST | `/api/auth/login` | `{ email, password, totp? }` → `{ user }` or 401 `TOTP_REQUIRED` / `INVALID_CREDENTIALS` |
| POST | `/api/auth/logout` | → `{ ok }` |
| GET | `/api/me` | → `{ user, mailboxes: MailboxSummary[] }` |
| PATCH | `/api/me` | `{ name?, theme?, density? }` → `{ user }` |
| POST | `/api/me/password` | `{ current, next }` → `{ ok }` |
| POST | `/api/me/totp/begin` | → `{ secret, otpauthUrl }` |
| POST | `/api/me/totp/enable` | `{ code }` → `{ recoveryCodes: string[] }` |
| POST | `/api/me/totp/disable` | `{ password }` → `{ ok }` |
| GET | `/api/me/sessions` · DELETE `/api/me/sessions/:id` | session management |

### Mail (mailbox-scoped; `:mb` = mailbox id)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/mailboxes/:mb/folders` | `Folder[]` with `unread`/`total` counts |
| POST/PATCH/DELETE | `/api/mailboxes/:mb/folders[/:id]` | custom folders only |
| GET | `/api/mailboxes/:mb/threads?folder=<id\|starred>&q=&cursor=` | `ThreadSummary[]`. `q` supports `from: to: subject: has:attachment is:unread is:starred` plus free text (FTS5) |
| GET | `/api/mailboxes/:mb/threads/:tid` | `{ thread, messages: MessageFull[] }`, where bodies are already inlined with signed `cid:` URLs |
| POST | `/api/mailboxes/:mb/threads/actions` | `{ threadIds, action: 'read'\|'unread'\|'star'\|'unstar'\|'archive'\|'trash'\|'spam'\|'not_spam'\|'move'\|'delete_forever', folderId? }` |
| GET | `/api/mailboxes/:mb/messages/:id/raw` | `message/rfc822` download |
| POST | `/api/mailboxes/:mb/drafts` | `DraftInput` → `MessageFull` (creates a draft) |
| PUT | `/api/mailboxes/:mb/drafts/:id` | `DraftInput` → `MessageFull` (autosave) |
| DELETE | `/api/mailboxes/:mb/drafts/:id` | discard |
| POST | `/api/mailboxes/:mb/drafts/:id/attachments` | multipart `file` → `Attachment` (≤ 25 MiB total) |
| DELETE | `/api/mailboxes/:mb/drafts/:id/attachments/:aid` | |
| POST | `/api/mailboxes/:mb/drafts/:id/send` | `{ sendAt? }` → `{ message, status: 'sent'\|'scheduled' }` |
| POST | `/api/mailboxes/:mb/messages/:id/cancel-schedule` | moves it back to Drafts |
| GET | `/api/contacts?q=` | autocomplete `Contact[]` (top 8) |
| GET/PUT | `/api/mailboxes/:mb/settings` | `{ displayName, signatureHtml, autoreply: {...} }` |
| GET/POST/PUT/DELETE | `/api/mailboxes/:mb/filters[/:id]` | `Filter` CRUD |
| GET/POST/DELETE | `/api/mailboxes/:mb/blocked[/:id]` | blocked senders |
| GET | `/api/mailboxes/:mb/poll?since=<ms>` | `{ newCount, latest: ThreadSummary[] }`, polled by the client every 30 s |
| GET | `/api/files/:aid?e=&s=` | signed attachment download (`?inline=1` for images) |
| POST | `/api/proxy/sign` | `{ urls: string[] }` (≤ 200, http/https only) → `{ signed: Record<url, proxyUrl> }` (session required) |
| GET | `/api/proxy/image?u=&s=` | signed remote-image proxy |

### Admin (`role=admin`)
| Method | Path |
|---|---|
| GET/POST/PATCH/DELETE | `/api/admin/users[/:id]` (create with a temp password; reset password; disable) |
| GET/POST/PATCH/DELETE | `/api/admin/domains[/:id]` (`catchAllMailboxId`) |
| GET | `/api/admin/domains/:id/check` → DNS health from DoH (`cloudflare-dns.com`): MX points at Cloudflare Email Routing, SPF includes Cloudflare, DMARC present |
| GET/POST/PATCH/DELETE | `/api/admin/mailboxes[/:id]` (address, displayName, members `[{userId, role}]`) |
| GET/POST/DELETE | `/api/admin/aliases[/:id]` |
| GET | `/api/admin/stats` → `{ users, mailboxes, messages, storageBytes, sentToday, sent30d, received30d }` |

## 6. Client (`src/client/`)

- **Stack:** React 19, React Router 8 (library mode), TanStack Query, Tailwind v4, TipTap 3 (compose), DOMPurify and lucide-react.
- **Layout (desktop):**
  - Left rail: mailbox switcher, then Compose, then folders.
  - Middle: thread list, virtualized for long lists.
  - Right: conversation reader. Messages are collapsible, and the latest one opens expanded.
- **Layout (< 768 px):** a single-pane stack with a bottom compose FAB.
- **Compose:** a floating sheet on desktop, full screen on mobile. It has To/Cc/Bcc chips with contact autocomplete, a From identity picker (the mailbox address plus aliases), and rich text (bold, italic, underline, lists, quote, link, code, clear formatting).
  - Attachments: drag and drop or file picker, with an upload progress bar.
  - Autosave every 3 s while the content is changing.
  - Send-later menu (later today, tomorrow morning, Monday morning, custom).
  - Undo send: a 5 s toast.
  - Reply quotes the parent with a `<blockquote>` header line.
- **Keyboard shortcuts:** `c` compose, `/` search, `j`/`k` next/previous, `o`/`Enter` open, `e` archive, `#` trash, `r` reply, `a` reply all, `f` forward, `s` star, `u` back to list, `Shift+I`/`Shift+U` read/unread, `?` shortcut sheet.
- **Theme:** light, dark or system. Density: comfortable or compact.
- **Notifications:** the client polls `/poll` every 30 s while the tab is visible, updates the document title unread count, and shows a browser `Notification` if permitted.
- **PWA:** `manifest.webmanifest`, icons, and a minimal service worker that caches the app shell only, never mail.
- **Screens:** Setup, Login (with TOTP step), Mail, Settings (Profile, Security/2FA/sessions, Mailbox: signature/vacation/filters/blocked, Appearance), Admin (Overview stats, Users, Domains with DNS check and setup guide, Mailboxes, Aliases).

## 7. Brand and visual system (v0.2 "Cobalt")

Cirrus is a tool people live in all day, so it should feel calm, fast and precise, like a well-made instrument, not a landing page. One colour does the work, and everything else is neutral graphite.

- **Name:** Cirrus Mail. **Mark:** an envelope whose flap curls into a cirrus wisp, drawn in the cobalt→sky gradient.
- **Cobalt (the one accent):** used only for the primary action, selection, focus, unread and links. Never as a large fill.

| Token | Light | Dark |
|---|---|---|
| primary | `#2B63E8` | `#4C82FF` |
| primary-hover | `#2456CF` | `#6A97FF` |
| primary-soft / selected bg | `#ECF2FF` | `rgb(76 130 255 / 0.14)` |
| selected-fg / link | `#1E4FC2` | `#8EB1FF` |
| sky (gradient end, brand only) | `#5CC8F5` | `#5CC8F5` |

- **Neutrals (graphite, hue-neutral, never navy):**

| Token | Light | Dark |
|---|---|---|
| bg (list, reader) | `#FFFFFF` | `#131417` |
| sidebar | `#F7F7F8` | `#0F1013` |
| surface-2 / input | `#F3F4F6` | `#1B1C20` |
| elevated (menus, compose) | `#FFFFFF` | `#1E1F24` |
| border (hairline) | `#E7E8EB` | `#25272D` |
| border-strong | `#D6D8DD` | `#33353C` |
| fg | `#15171C` | `#ECEDEF` |
| muted | `#5F6470` | `#9A9EA8` |
| faint | `#8D919B` | `#6D717B` |
| hover | `#F2F3F5` | `#1C1D21` |

- **Status colours are muted and used sparingly:** danger `#D03A3A`/`#FF6B6B`, success `#1A8F5C`/`#4CC38A`, warning `#B26B00`/`#F5B14C`.
- **Type:** Inter Variable with `cv11`, `ss01` and `tnum` for times. The UI base is 13px/20px, metadata 12px, the reader body 14.5px/1.6, and the thread subject 18px/600 with −0.01em tracking. No all-caps labels, no letter-spaced eyebrows.
- **Shape:** radius 6px on controls, 10px on floating surfaces (menus, compose, dialogs), 0 on panes. Hairline 1px borders separate panes. No cards inside cards. Shadows only on floating layers.
- **Density:** sidebar items 28px, thread rows two lines (about 58px comfortable, 40px compact), icon buttons 28px with 16px icons at stroke 1.75.
- **Motion:** at most 120ms, only in response to an action (open, close, confirm). No entrance animations, no shimmer beyond skeletons. Respect `prefers-reduced-motion`.
- **Speed is a feature:** opening a thread must feel instant. Prefetch on hover and j/k, render from cache first, update optimistically, and keep first-load JS small.
- **Assets:** `brand/` holds the logo SVGs, favicon, PWA icons, social card and README banner. `site/` is the landing page. `docs/` holds the setup guide and architecture diagram.

## 8. Out of scope for v0.1 (roadmap)

IMAP/JMAP access, Web Push, labels as a separate concept from folders, calendar/contacts sync, PGP, passkeys, mobile apps, an AI triage add-on (Workers AI) and mbox import.
