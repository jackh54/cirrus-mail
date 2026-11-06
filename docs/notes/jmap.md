# JMAP (RFC 8620 core, RFC 8621 mail, submission, vacation)

Migration `0017_jmap.sql`. Code: `src/worker/jmap/` (`handler.ts` HTTP + session + EventSource, `core.ts` request processor, `mailbox.ts`, `email.ts`, `submission.ts`, `blob.ts`, `auth.ts`). Tests: `test/jmap.test.ts`.
Lets JMAP clients (Ltt.rs, aerc, Thunderbird, a future iOS app) use Cirrus. IMAP is impossible: Workers cannot accept inbound TCP.

## Routes
`/.well-known/jmap` (301 to `/jmap/session`), `GET /jmap/session`, `POST /jmap/api`, `GET /jmap/download/{accountId}/{blobId}/{name}?accept=`, `POST /jmap/upload/{accountId}/`, `GET /jmap/eventsource/?types=&closeafter=&ping=`. All are in `run_worker_first` and routed in `index.ts` like `/dav`, outside `/api` and its CSRF middleware.

## Auth
HTTP Basic (login email + app password) as for `/dav`, or `Authorization: Bearer <app password>`. The session cookie and the account password are never read. Failed attempts use the DAV counters (`davfail:ip:` 30 per 15 min; Basic also `davfail:user:` 10). Bearer has no username, so only the per-IP counter applies to it.
CORS: none by default. `settings.jmap_cors_origins` (comma-separated exact origins) is the allowlist; matching origins get `Access-Control-Allow-Origin` echoed, no credentials. Native clients need none of this.

## Data model
- Account: one per mailbox the user is a member of, `accountId` = mailbox id. `isPersonal` = sole member, `isReadOnly` = false.
- Mailbox: Cirrus folders and labels. Roles: inbox, sent, drafts, trash, archive, spam -> `junk`; Scheduled and labels have no role. Mailbox objects also carry `cirrusKind` (`folder`|`label`) and `cirrusColor` (vendor capability `urn:cirrus:params:jmap:labels`). `Mailbox/set` create makes a folder unless `cirrusKind: "label"`.
- Email: a Cirrus message. `mailboxIds` = its folder + its labels; `Email/set` must leave exactly one folder (plus any labels), else `invalidProperties`. Drafts/Scheduled cannot be targets; outbox mail (draft, scheduled) can only move to Trash; spam only takes received mail.
- Keywords: `$seen` = read, `$flagged` = starred (not applied to drafts/scheduled, as in the API), `$draft` = draft/failed status (read-only; clearing it is a no-op, so the usual `onSuccessUpdateEmail` works). Everything else (`$answered`, `$forwarded`, custom) is accepted and **ignored**, not stored.
- Thread: the Cirrus thread (emailIds oldest first).
- Identity: the mailbox address plus aliases with `can_send`.
- Blob ids: `m_<msg>` raw message (the stored `.eml`; sent mail and drafts have none, so one is synthesised on download), `t_`/`h_<msg>` text/HTML part, `a_<attachment>`, `u_<upload>`. Every lookup is scoped by `mailbox_id = accountId` after a membership check; a non-member gets 404.
- Email bodies are synthetic: `multipart/mixed[ multipart/alternative[text(1), html(2)], attachments(3..) ]`. Part ids are only meaningful in the JMAP view.
- `Email/set` destroy follows `threads/actions`: not in Trash/Spam -> moved to Trash (and still listed as destroyed); in Trash/Spam -> deleted forever. Scheduled/sending mail is `forbidden`. `Mailbox/set` destroy of a folder with mail needs `onDestroyRemoveEmails: true` and then archives the mail (Cirrus semantics), labels are just removed from mail.

## State and changes
Triggers in the migration keep everything current, so no write path knows about JMAP and no extra D1 round trips are added:
- `modseq` (last change) and `cseq` (creation) columns on messages, threads, folders, labels. `jmap_state(mailbox_id, seq, email, mailbox, thread, pruned)` is one counter per mailbox; each trigger does one upsert that bumps `seq` and the type columns, then stamps the row.
- State strings are the type's column (`Email`, `Mailbox`, `Thread`). `message_labels` changes bump the Email. Message changes that move counts (folder, read, status, insert, delete) also bump `Mailbox`; `Mailbox/changes` then reports every mailbox with `updatedProperties` = the four count properties.
- Updates only bump when a JMAP-visible column changed (folder, read, starred, status, subject, body_key, addresses, attachments, size, Message-ID, date), so the inline-body backfill, FTS rowids and `updated_at` touches do not cause changes.
- Deletes write `jmap_tombstones(mailbox_id, type, id, modseq, created_at)`. There is deliberately no foreign key (triggers also fire while a mailbox is cascade-deleted); the hourly cron removes rows of deleted mailboxes.
- Cron prunes tombstones older than 30 days and records the highest pruned modseq in `jmap_state.pruned`. A `sinceState` that is malformed, newer than the current state, or older than `pruned` gets `cannotCalculateChanges` (a sinceState equal to the current state is always fine).
- `*Query/queryChanges` always answers `cannotCalculateChanges`; `canCalculateChanges` is false.

## Limits
`maxCallsInRequest` 16 (HTTP 400 `limit`), `maxObjectsInGet` and `maxObjectsInSet` 500 (`requestTooLarge`), `maxSizeRequest` 10 MB (413), `maxSizeUpload` 50 MB (413). `maxConcurrentRequests`/`maxConcurrentUpload` are advertised, not enforced; instead at most 100 pending uploads per mailbox (429). D1 allows 100 bound variables, so id lists are bound as one JSON array (`json_each`) and a filter needing more than 90 binds is `unsupportedFilter`.

## Methods
Core/echo; Mailbox/get, changes, query, queryChanges, set; Email/get (properties, bodyProperties, `fetch*BodyValues`, `maxBodyValueBytes`, `header:Name[:asText|asAddresses|asMessageIds|asDate][:all]` for the stored headers), changes, query, queryChanges, set (keywords, mailboxIds, drafts, destroy), import; Thread/get, changes; SearchSnippet/get (`<mark>` over the filter's text/subject/body terms); Identity/get, changes; EmailSubmission/set (with `onSuccessUpdateEmail` / `onSuccessDestroyEmail`, answered with the implicit `Email/set`); VacationResponse/get, set.
Back-references (`#name` with `resultOf`, JSON pointer, `*`) and creation ids (`#id` anywhere in arguments, also as object keys) work.
- Email/query: filters inMailbox, inMailboxOtherThan, text and body (FTS), from, to, cc, bcc, subject, before, after, minSize, maxSize, hasKeyword, notKeyword, all/some/noneInThread keyword, hasAttachment, AND/OR/NOT. Sorts receivedAt, sentAt, size. `collapseThreads`, `position` (negative too), `anchor`/`anchorOffset`, `limit`, `calculateTotal`. Anchor and negative positions scan up to 10,000 matches.
- Email/set create makes drafts only (mailboxIds must be the Drafts folder plus labels); `from` must be a sendable identity; body from `textBody`/`htmlBody`/`bodyStructure` + `bodyValues`; attachments from upload or attachment blobs (copied to `att/`). Replies join the thread of `inReplyTo`.
- Email/import parses the blob with postal-mime and stores it like inbound mail (no spam scoring, filters, push or auto-reply). Folder `sent` imports as sent, `drafts` as a draft.
- EmailSubmission uses `validateDraft`, `claimForSend` and `performSend`, so `send_counts`, `send_log`, contacts and the move to Sent are the normal ones. Envelopes are accepted only if they match the message's recipients. Quota errors map to `forbiddenToSend`.
- VacationResponse maps to the mailbox auto-reply columns (`htmlBody` is converted to text; only a text body is stored).

## Uploads and downloads
Uploads go to R2 `jmapup/<mailbox>/<id>` with a row in `jmap_uploads`; the hourly cron removes uploads older than 6 hours. Downloads always send `Content-Disposition: attachment`, `nosniff` and `Content-Security-Policy: sandbox`; `?accept=` only changes the Content-Type.

## EventSource
`eventStream()` in `handler.ts`: one query on `jmap_state` (joined to the caller's memberships) every 15 s, `StateChange` events for the requested `types` (Email, Mailbox, Thread; no Identity or VacationResponse), `ping` events every `ping` seconds (15-300, 0 = off), a comment heartbeat otherwise, close after 5 minutes or after the first event with `closeafter=state`. `Last-Event-ID` (the id of the previous event) different from the current state triggers an immediate event.

## Not covered / not verified
- Not tried with a real client (Ltt.rs, aerc, Thunderbird), nor against remote D1/R2; EventSource timing was only tested with short intervals.
- Not implemented: Email/parse, Email/copy, Blob/copy, Identity/set, EmailSubmission/get|query|changes, push (PushSubscription), delayed sending, Mailbox hierarchy, `sender`, `$answered`.
- Body structure and part ids are generated, not parsed from the raw message; a client that parses the raw blob itself sees the original MIME for received mail.
- `Email/set` on very large batches is not atomic across chunks of 100 statements.
