# Inline bodies

`messages.body_inline` (migration 0011) holds the same `{html,text}` JSON as the R2 object at `body_key`, when html + text is at most 64 KB (`INLINE_BODY_MAX` in `src/worker/lib/db.ts`). NULL means read R2.

- R2 is still written for every body. Deletion, drafts' versioned keys and the backfill all rely on `body_key`, and the object is the source of truth if the inline copy is ever dropped. The win is on reads only.
- Written inline: inbound (handler.ts), draft create and every draft save (same statement as `body_key`, so the two cannot diverge; a body that grows past the limit gets NULL). Sent and scheduled messages are the draft row, so they carry it along.
- Read via `loadRowBody` (thread detail, message full, performSend); it falls back to R2.
- List queries never select it; only `m.*` / `SELECT *` single-thread or single-message reads do.
- Backfill: `src/worker/lib/inline-backfill.ts`, run from `runCron` every minute, 200 rows, cursor in `settings.inline_backfill_cursor`. Idempotent; the update only applies while `body_key` is unchanged.
