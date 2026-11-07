# AGENTS.md

Guidance for AI coding agents working on Cirrus Mail. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/development.md](docs/development.md). If a user asks you to deploy Cirrus rather than change it, jump to [Helping a user deploy Cirrus](#helping-a-user-deploy-cirrus).

Cirrus Mail is a self-hosted email suite that runs on the user's own Cloudflare account: Email Routing in, Email Sending out, D1 and R2 storage, one Hono Worker that also serves a React web client. It is in beta.

## Stack

- Worker: TypeScript (strict), Hono, Cloudflare Workers runtime with `nodejs_compat`. Bindings (see `wrangler.jsonc`): `DB` (D1), `BUCKET` (R2), `ASSETS`, `EMAIL` (`send_email`), `AI` (Workers AI, optional). A cron trigger runs every minute.
- Client: React 19, Vite, Tailwind v4, TanStack Query, TipTap, `react-router`. PGP uses `openpgp` in the browser.
- Tests: Vitest with `@cloudflare/vitest-pool-workers`, so they run in workerd against real D1 and R2 bindings.
- Node.js 22+, npm (`npm ci`, the repo has a lockfile).
- No Durable Objects, no Queues, no third-party services. Don't add any.

## Layout

```
src/worker/        Hono Worker: fetch(), email(), scheduled()
  inbound/         email() pipeline: parse, resolve, thread, spam, filters, auto-reply
  outbound/        drafts, sending, scheduled sends
  routes/          /api/* handlers
  dav/ jmap/ mbox/ CalDAV/CardDAV, JMAP and mbox import/export
  middleware/      sessions, CSRF header check, admin guard
  lib/             crypto, signing, helpers
src/client/        React web client
src/shared/        code both sides import: api.ts (API types), ulid.ts, tz.ts
migrations/        numbered D1 migrations
test/              Vitest suites
docs/              design.md (spec), setup.md, faq.md, development.md, notes/ (per-subsystem notes)
site/              static landing page (own wrangler.jsonc, no build step)
scripts/           dev and deploy helpers
```

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install |
| `cp .dev.vars.example .dev.vars && npm run db:migrate:local` | One-time local secrets and schema |
| `npm run dev` | Vite plus the Worker in workerd, with local D1 and R2. Sends are simulated. |
| `npm run typecheck` | Worker and client `tsc` projects |
| `npm test` | Full Vitest suite (`npx vitest run test/<file>.test.ts` for one file) |
| `npm run check` | `typecheck` and `test` |
| `npm run build` | Production build |
| `npm run deploy` | `check`, `build`, remote D1 migrations, `scripts/check-migrations.mjs` (deploy guard: refuses to ship if remote migrations are unapplied), `wrangler deploy`, migrations again |

Don't run `npm run deploy`, `db:migrate:remote` or anything with `--remote` unless the user asked you to deploy to their account. CI runs typecheck, test and build.

## Conventions

- **Commits:** Conventional Commits, for example `feat(compose): add send-later menu`, `fix(inbound): handle empty subject`, `docs: ...`.
- **D1 migrations:** add a new numbered file in `migrations/` for every schema change. Never edit a migration that has been applied anywhere; write a new one. Use the next number after the highest existing file.
- **API contract:** `docs/design.md` section 5 is binding for both Worker and client, and `src/shared/api.ts` holds the matching types. Change both together, and update Worker and client in the same change.
- **IDs and time:** IDs are ULIDs from `src/shared/ulid.ts` (the only generator). Timestamps are integer epoch milliseconds.
- **Errors:** `{ "error": { "code": "SNAKE_CASE", "message": "..." } }` with a suitable status.
- **Privacy:** never log message content, addresses, tokens or secrets. Invocation logs are off in `wrangler.jsonc`; keep them off.
- **Security-sensitive code** (auth, sessions, signing, HTML rendering, image proxy, DAV, JMAP, PGP) needs a test.
- **Tests:** add a test with every bug fix and every new route, in `test/`.
- **Scope:** Cirrus deliberately has no bulk-mail or marketing features. Don't add them.
- **Docs:** update `docs/` and the README when behaviour, config or setup steps change. Subsystem notes live in `docs/notes/` and list what is not verified; keep those honest.

## Helping a user deploy Cirrus

Do these in order. Steps 1 to 3 and 7 are dashboard actions the user does; you can guide them.

1. **Workers Paid is required.** Email Sending is only available on Workers Paid ($5/month, includes 3,000 outbound emails a month, then $0.35 per 1,000). Inbound mail is free.
2. **The domain must be on Cloudflare DNS.** Use the apex (`example.com`) for mail, because catch-all routing works on apex domains only. The web app can be on a subdomain. Enabling Email Routing replaces existing MX records, so if the domain already receives mail elsewhere, suggest a spare domain first.
3. **Onboard Email Sending**, then **enable Email Routing**: dashboard, Compute & AI, Email Service. Wait for Email Sending to show verified. Add a DMARC TXT record at `_dmarc` (for example `v=DMARC1; p=none; rua=mailto:you@example.com`). Don't create the catch-all rule yet.
4. **Secrets:** `SETUP_TOKEN` (a one-time token typed on the first-run screen) and `APP_SECRET` (32+ random characters, signs attachment and image-proxy URLs). Generate with `openssl rand -base64 32`. The user should enter them themselves; don't ask them to paste secrets into chat. Values under 24 characters or starting with `change-me` are refused.
5. **Deploy**, either:
   - Button: https://deploy.workers.cloudflare.com/?url=https://github.com/jackh54/cirrus-mail . D1 and R2 are provisioned automatically; enter the two secrets when prompted.
   - CLI:
     ```sh
     git clone https://github.com/jackh54/cirrus-mail.git && cd cirrus-mail
     npm ci && npx wrangler login
     npx wrangler secret put SETUP_TOKEN
     npx wrangler secret put APP_SECRET
     npm run deploy
     ```
     `wrangler secret put` offers to create the Worker if it doesn't exist; say yes. With several Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID`. Don't change the binding names in `wrangler.jsonc`.
6. **First-run setup:** open `/setup` on the deployed URL, enter `SETUP_TOKEN`, and create the admin account. It only works while there are no users. Then in Admin add the domain and mailboxes (`Domains`, `Mailboxes`).
7. **Catch-all routing rule:** Email Routing, Routing rules, Catch-all address, action "Send to a Worker", destination `cirrus-mail`, enabled. Or put `"addresses": ["*@example.com"]` in `wrangler.jsonc` and redeploy. Mail to an address with no mailbox, alias or catch-all is rejected with `550 5.1.1 No such user`.
8. **Verify:** Admin, Domains, DNS check; then send a message in each direction and check `spf=pass`, `dkim=pass`, `dmarc=pass` in the received headers.

Common failures: `E_SENDER_NOT_VERIFIED` (domain not onboarded to Email Sending yet), `E_DAILY_LIMIT_EXCEEDED` (Cloudflare's daily quota; retry tomorrow), mail not arriving (catch-all not pointing at the Worker, or no mailbox for the address), `/setup` answering 503 (secret missing or a placeholder). Full guide: [docs/setup.md](docs/setup.md), and a one-file version in [llms-full.txt](llms-full.txt).

Be straight with the user about limits: no IMAP (Workers can't accept inbound TCP; JMAP is offered instead), Email Sending is in beta, and Cloudflare documents it for transactional mail, so they should read Cloudflare's terms for their use. See [docs/faq.md](docs/faq.md).
