# mbox import and export

Move mail in from Gmail (Google Takeout), Apple Mail or Thunderbird, and out again. UI: Settings, Mailbox, "Import mail" and "Export mail". Any member of the mailbox can use both.

## Schema (`migrations/0016_mbox.sql`)

- `mbox_imports`: one row per import. `status` is `uploading`, `processing`, `done`, `failed` or `cancelled`. A partial unique index on `(mailbox_id) WHERE status IN ('uploading','processing')` allows one active import per mailbox. Only the newest import is kept: starting one deletes older finished rows.
- Persisted progress: `cursor` (byte offset), `skipping`, `imported`, `duplicates`, `skipped`, `error_count`, `errors_json` (first 20 reasons, never content), `lease_until`.
- `idx_messages_content_hash (mailbox_id, content_hash) WHERE content_hash IS NOT NULL`, for deduping messages without a Message-ID. It adds one small index write to every stored message.

## Routes (under `/api/mailboxes/:mb`, behind `requireMailbox`)

| Route | Notes |
|---|---|
| `GET /import` | Latest import (`MboxImport`) or `null`. The UI polls it every 3 s while processing. |
| `POST /import` `{filename, size, folderId?, markRead?}` | Starts a multipart upload in R2 (`import/<mb>/<id>.mbox`). 409 `IMPORT_ACTIVE`, 400 above 20 GB or for a folder outside the mailbox. `partSize` in the reply is 16 MB. |
| `PUT /import/:id/parts/:n` | Raw bytes of part `n`; must be exactly 16 MB (the last part: the remainder). Only the member who started the import (403 for others). Re-sending a part replaces it. |
| `POST /import/:id/complete` | 409 `MISSING_PARTS` lists what is missing; checks the assembled size; then the import is `processing`. |
| `DELETE /import/:id` | Active: aborts the upload / stops processing and deletes the R2 object; mail already imported stays. Finished: removes the row. |
| `GET /export?scope=mailbox\|folder\|label&id=` | Streamed `.mbox` download. 5 per user per hour (429), counted in `rate_limits`. |

A reload during an upload is resumable: `uploadedParts` is stored server-side, and the user picks the same file again (checked by name and size). Parts are sent one at a time with up to 4 attempts.

## Processing (`src/worker/mbox/import.ts`, called last in `runCron`)

- One import per tick, the least recently served, so mailboxes take turns. A lease (`lease_until`) stops overlapping ticks from working on the same import. Stops at 20 s wall clock or 500 messages (always at least one message per tick, so it cannot stall). A stale `uploading` row older than 3 days is aborted.
- Reads `BUCKET.get(key, { range })` windows of 8 MB. **Decision:** the "carry-over" is not stored in D1. The cursor is always the offset of a message start, and a message cut off by the window is simply read again from there (the window doubles up to 26 MB when one message is bigger). A message over 25 MB is counted as skipped and scanned past without buffering it (`skipping` is persisted across ticks).
- Separator: a line starting `From ` after a blank line, or at the start of the file. `>From`, `>>From` ... lose one `>` (mboxrd, which also covers mboxo). CRLF files and a last message without a trailing newline work. A file that does not start with `From ` fails with `not_an_mbox_file`.
- Stored the way inbound mail is (raw and body in R2, inline body, attachments, FTS, `findThread`), but no filters, auto-reply, push, send counts or spam scoring. Spam scoring is replaced by the Gmail `Spam` label: those go to Spam with a score at the threshold.
- Date: the message `Date` (else the separator line's), clamped to between 1990-01-01 and now + 5 minutes. It is `date`, `display_date` and `created_at`; keeping `created_at` old means the new-mail poll does not announce an import. `folder_changed_at` is now, so imported Trash and Spam get their normal 30 days.
- Dedupe: by Message-ID within the mailbox (any folder, either direction), else by content hash. Re-running an import adds nothing. A duplicate is not re-labelled.
- Errors: a message that cannot be parsed or stored is counted and the reason (`byte <offset>: parse_error`) kept for the first 20. Cancelling is noticed at the next save; a tick in flight finishes the message it is on.
- The R2 source object is deleted when the import ends (done, failed or cancelled).

Throughput is a few messages per second per mailbox (several D1 and R2 round trips each, one message at a time to keep threading correct), so a very large Takeout takes many minutes. It keeps going in the background.

## Gmail mapping (`X-Gmail-Labels`, per message)

- Folder: Trash, else Spam, else Drafts, else Inbox, else Sent, else Archive. Sent mail is stored as outgoing.
- `Starred` is a star; everything is read except `Unread`.
- **Drafts are skipped** (counted as skipped): a draft has compose state Cirrus cannot rebuild, and a half-written message as "received mail" would be wrong.
- Ignored: `Important`, `Opened`, `Chat`, `Archived`, `Category ...`.
- Every other label becomes a Cirrus label: matched case-insensitively against existing ones, created when missing (colour from a hash of the name), names cut at 40 characters, nothing created past 100 labels per mailbox. Quoted names containing commas and RFC 2047 encoded names are handled. Nested labels ("Work/Projects") keep their full name as one label.
- Messages without that header (Apple Mail, Thunderbird, a partial Gmail file) go to the folder chosen at upload (default Archive), unread unless "Mark everything as read" (the default) is on.
- `X-GM-THRID` is not used; threading uses References / In-Reply-To and subject like inbound mail, which gives the same result for normal conversations.

## Export (`src/worker/mbox/export.ts`)

- A `TransformStream`; messages are read 50 at a time by `(date, id)`, so memory stays at about a page. Only received and sent messages (no drafts or scheduled). Trash and Spam are included when exporting the whole mailbox or those folders.
- Each message is `From <addr> <asctime>`, the message with mboxrd `>From ` escaping, and a blank line.
- A message with its raw `.eml` in R2 is written as stored. One without (sent mail) is **rebuilt**: From, To, Cc, Reply-To, Subject (RFC 2047), Date, Message-ID, In-Reply-To, References, then text and HTML as base64 parts (`multipart/alternative`) and attachments as base64 parts under `multipart/mixed`. Bcc is not exported. This is a reasonable RFC 5322 message, not the byte-identical original.
- Gmail labels are not written to the export, so re-importing it into Cirrus uses the chosen folder rather than the original folders.

## Security

- Every route is mailbox-scoped; a non-member gets 404, no session 401. Parts and completion are limited to the member who started the import. Folder and label ids are checked against the mailbox. Nothing logs message content or addresses; error samples hold byte offsets and fixed reason codes only.

## Not verified

- Not run against a real multi-GB Takeout, a deployed R2 or in a browser. Tests use the local Workers runtime; the largest test file is about 26 MB.
- Cron wall-clock and CPU limits on a deployed Worker were not measured; the 20 s budget is a bound on the loop, not a measurement.
