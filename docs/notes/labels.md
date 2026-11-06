# Labels

Folders hold a message in exactly one place. Labels are tags: a thread can carry any number of them.

## Schema (`migrations/0009_labels.sql`)

- `labels(id, mailbox_id, name COLLATE NOCASE, color, created_at)`, `UNIQUE (mailbox_id, name)`, so names are unique per mailbox ignoring case. `mailbox_id` cascades.
- `message_labels(message_id, label_id)`, primary key on both, index on `(label_id, message_id)`. Both columns cascade, so deleting a label, a message (including "delete forever") or a mailbox removes the links.
- Labels live on messages, so a later JMAP feature can have per-message membership. Applying a label to a thread labels all of its current messages; a thread's labels are the union over its messages. A message that arrives later in a labelled thread does not inherit the label (unless a filter labels it).
- `color` is one of `LABEL_COLORS` (cobalt, sky, teal, green, amber, orange, red, pink, violet, graphite), checked by the API, not by a SQL constraint, so the palette can grow without a migration.

## Routes (all under `/api/mailboxes/:mb`)

| Route | Notes |
|---|---|
| `GET /labels` | `Label[]` with `unread` (unread messages with the label outside Trash/Spam). A hot read: authorizes in the same D1 batch (`labelReads`, mounted before the guard), one round trip. |
| `POST /labels` `{name, color}` | 201, 409 `LABEL_EXISTS`, 400 `TOO_MANY_LABELS` (100 per mailbox). |
| `PATCH /labels/:id` `{name?, color?}` | 404 / 409. |
| `DELETE /labels/:id` | Removes the label from every message, then the label. Messages are kept. |
| `POST /threads/labels` `{threadIds, add?, remove?}` | One batch. 404 if no thread is in this mailbox or any label is not. Thread ids from other mailboxes are skipped. All writes are guarded so nothing is written unless every label belongs to the mailbox. At most 500 threads, 20 labels each way; the same id in both is a 400. |
| `GET /threads?label=<id>` | Threads with the label, newest first, same cursor pagination as folders. Excludes Trash and Spam (like Starred). The label check rides in the same batch (404 `Label not found`). |

`ThreadSummary.labels` is a list of label ids (the client resolves names and colours from `GET /labels`). It is computed in the same statement as the thread list, poll and thread detail (`threadLabelsSql` in `src/worker/lib/db.ts`), so those stay one D1 round trip.

`pageSummariesSql` now binds the mailbox id twice before `extraCols` (folder ids, then label ids). Any other caller of it must add that extra bind.

## Search and filters

- `label:name` or `label:"two words"` in search matches messages carrying a label with that name in the same mailbox, ignoring case. Combine with other operators and free text.
- Filter action `{ type: 'apply_label', labelId }`. The filters API checks the label belongs to the mailbox (400 `INVALID_LABEL`). On inbound mail the link is inserted with `INSERT ... SELECT ... FROM labels WHERE id = ? AND mailbox_id = ?`, so a label deleted after the filter was saved is skipped and the mail is delivered unlabelled. The filter editor shows "(deleted label)"; the filter itself is not rewritten. Filters are not run for spam, so spam is never labelled by them. At most 10 labels per message from filters.

## UI

- Rail: "Labels" section under the custom folders (create, rename/recolour, delete, unread badge). URL `/mail/:mb/label:<id>`; the list key is `label:<id>`.
- Chips on thread rows (comfortable, compact, phone; two chips then `+N`) and under the subject in the reader.
- Label picker (`LabelPicker`, a dialog of tri-state checkboxes with "Create label"): reader toolbar, phone reader bottom bar, bulk bar, long-press action sheet, `l` key and the command palette ("Label as…", "Go to label X"). Toggling applies at once, optimistically.
- Search help and the shortcuts sheet mention `label:` and `l`.

## Security

- Every route is mailbox-scoped: `GET /labels` and the label thread list authorize through `authorizeMailbox`; the writes sit behind `requireMailbox`. A non-member gets 404, no session 401 (tested, including the batched statements returning no rows).
- Writes filter by `mailbox_id` on the thread, message and label side, so ids from another mailbox match nothing.
- Names are control-character stripped (`zHeaderText`), max 40. Nothing here logs names or message content.

## Not verified / known limits

- Not run in a browser: the UI is type-checked and builds, but the picker, rail section and phone layouts were not exercised by hand.
- Empty-label deletion does not rewrite filters that reference it (see above).
- The rail unread count is per message, like folder counts, and refreshes when new mail arrives (poll), on label changes and on thread actions.
