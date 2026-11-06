# Snooze, mute, one-click unsubscribe, reply templates

Migration `0013_extras.sql`. Tests: `test/extras.test.ts`.

## Snooze
- `threads.snoozed_until` (epoch ms). Actions `snooze` (needs `until`: future, at most 366 days), `unsnooze` on `POST /threads/actions`.
- Snoozed threads are hidden from Inbox views (default list and the Inbox folder id) and listed by `GET /threads?folder=snoozed`.
- Archive, trash, spam, not-spam and move clear the snooze.
- Cron (`src/worker/snooze.ts`, called from `runCron` every minute): at most 100 due threads per tick. Per thread, one D1 batch updates the latest inbound message (moved into the Inbox if the thread was archived; `date` raised to the wake time so received-time ordering puts it on top; `display_date` keeps the sender's date; marked unread) and clears `snoozed_until`, both guarded by `snoozed_until <= now`. `meta.changes` of the clear is the claim, so overlapping runs wake and push a thread once. Push reuses `notifyNewMail` (not sent for muted threads).
- An inbound message that lands in the Inbox of a snoozed thread clears the snooze.
- Client: `b` (controller hotkey), reader toolbar, bulk bar, phone reader bar, long-press sheet, reader overflow menu, palette ("Snooze conversation…", "Go to Snoozed"). Presets are computed in the browser's local time (`src/client/lib/snooze.ts`).

## Mute
- `threads.muted`. Actions `mute` / `unmute`. Inbound mail for a muted thread that would land in the Inbox goes to Archive, read, no push. Shortcut `m`, reader overflow menu, palette, long-press sheet. Muted icon on the row.

## One-click unsubscribe
- `messages.unsub_json` is written at receive time only when the message has aligned authentication (`auth.aligned` and DMARC not `fail`). Only https URLs on public-looking hostnames and mailto addresses are kept.
- `POST /mailboxes/:mb/messages/:id/unsubscribe` `{ blockSender? }`. The body never carries a URL. Order: https + `List-Unsubscribe-Post` -> server POST (https only, `redirect: 'manual'`, 5 s timeout, 2xx = ok); else mailto -> email from the mailbox (counted by `recordSendsSafe`, logged in `send_log`); else the browser opens the https link. 30 requests per user per hour.
- The reader shows "Unsubscribe" on the latest message that has one, with a confirmation dialog and an "also block sender" option (inserts into `blocked_senders`).

## Reply templates
- `reply_templates` per mailbox; `GET/POST /mailboxes/:mb/templates`, `PATCH/DELETE .../templates/:id`; members only (404 otherwise), 100 per mailbox.
- The send path does not rewrite outgoing HTML on the server (the TipTap schema is the effective filter), so templates are cleaned on the way in with `HTMLRewriter` (`src/worker/lib/template-html.ts`): scripts, embeds, forms, event handlers, script-capable URLs and style rules that load resources are stripped.
- Compose has an "Insert template" menu (inserts at the cursor, fills an empty subject). Manage them under Settings, Mailbox.

## Known gaps
- The Inbox unread badge and mailbox unread count still include snoozed threads.
- The 30 s poll does not notice a wake (it keys on `created_at`); the list refreshes on its next fetch and the push tells the user.
- The Snoozed view is ordered by latest message, not by wake time.
