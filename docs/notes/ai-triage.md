# Optional AI triage (Workers AI)

Off by default. An admin turns it on in Admin > Overview > AI. When on, the text of new Inbox mail (first ~1,500 characters, plus From and Subject) and of any conversation someone chooses to summarise goes to Workers AI on the same Cloudflare account, billed per use by Cloudflare. Nothing leaves the account, and message content is never logged.

## What it does

- **Inbox tabs:** Primary, Updates, Promotions, Social, Forums. A new non-spam Inbox message gets a category in `ctx.waitUntil` after it is stored, so delivery never waits on it. The thread follows its latest inbound message. Unclassified threads show as Primary. The order of checks:
  1. A remembered sender override for the mailbox (`sender_categories`), set by "Always for this sender" after moving a thread by hand.
  2. Header and sender rules in `heuristicCategory` (`src/worker/lib/ai.ts`): List-Unsubscribe, Precedence, Auto-Submitted, List-Id, known social and forum senders, no-reply style senders, transactional subjects. Free.
  3. Only if both are unsure, one model call (`AI_CLASSIFY_MODEL`, JSON mode with an enum schema).
- **Summarise:** a button in the reader for conversations with 3+ messages or a long body (also "Summarise conversation" in the palette). Bullets are cached per thread in `thread_summaries`; the cache is keyed by message count + newest message id, so new mail makes it stale. Limited to 10 per user per 10 minutes (cache hits are free).
- **Budget:** `settings.ai_daily_budget` (default 500) caps model calls per UTC day, counted in `ai_usage`. Over budget, classification is skipped silently and Summarise returns 429 `AI_BUDGET_EXCEEDED`.
- **Per-user switch:** Settings > Appearance > Inbox tabs (`users.category_tabs`). Tabs are hidden entirely while the feature is off.

## Failure behaviour

A missing `env.AI`, a thrown error (including "JSON Mode couldn't be met"), bad JSON, an unknown category or a spent budget all degrade to no AI: the thread keeps its category (Primary if it has none) and the message is delivered. Summarise reports `AI_UNAVAILABLE` (503), `AI_FAILED` (502), `AI_DISABLED` (409) or `AI_BUDGET_EXCEEDED` (429).

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/ai/status` | any signed-in user, `{ enabled }` |
| GET/PATCH | `/api/admin/ai` | admin; `{ enabled, dailyBudget, usedToday, available }` |
| GET | `/api/mailboxes/:mb/threads?category=` | Inbox list filtered to one tab |
| GET | `/api/mailboxes/:mb/categories` | unread conversations per tab |
| PUT | `/api/mailboxes/:mb/threads/:tid/category` | `{ category, rememberSender? }` |
| GET/POST | `/api/mailboxes/:mb/threads/:tid/summary` | GET = fresh cache or null; POST = cache or one model call |
| PATCH | `/api/me` | now accepts `categoryTabs` |

## Dev and tests

The `AI` binding is remote-only. Two config changes keep local work offline:

- `vite.config.ts`: `cloudflare({ remoteBindings: false })`, so `npm run dev` doesn't need a Cloudflare login. AI calls then fail in dev and the app falls back to no AI. To try the real model in dev, remove that option and log in with wrangler.
- `vitest.config.ts`: `remoteBindings: false`. Tests inject a fake with the same `run(model, input)` shape through the env (`withEnv({ AI })` in `test/ai.test.ts`).

`worker-configuration.d.ts` types `AI` as optional (`AI?: Ai`) by hand; `wrangler types` would emit it as required, so re-apply that if you regenerate.
