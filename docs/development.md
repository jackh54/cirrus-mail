# Developing Cirrus Mail

Everything runs locally: the Worker, D1, R2 and the React client, with hot reload. You don't need a Cloudflare account to hack on it.

## Requirements

- Node.js 22+
- npm (the repo uses `package-lock.json`, so use `npm ci`)

## First run

```sh
git clone https://github.com/jackh54/cirrus-mail.git
cd cirrus-mail
npm ci
cp .dev.vars.example .dev.vars      # local secrets: SETUP_TOKEN, APP_SECRET
npm run db:migrate:local            # create the local D1 schema
npm run dev
```

Open the URL Vite prints, go to `/setup`, and create an admin with the `SETUP_TOKEN` from your `.dev.vars`.

`npm run dev` starts Vite with the Cloudflare plugin, so the Worker runs in the real Workers runtime (workerd) next to the client dev server. D1 and R2 are local, stored under `.wrangler/`.

**Sending is simulated locally.** The `send_email` binding doesn't deliver anything in local dev; each send is logged to the terminal instead. To send real mail while developing, set `"remote": true` on the `send_email` binding in `wrangler.jsonc`. Only do that on purpose, and don't commit it.

## Demo data and test mail

```sh
node scripts/seed-demo.mjs          # fill the local database with demo mailboxes and threads
node scripts/send-test-email.mjs    # deliver a test message to the local email() handler
```

Both scripts talk to your running `npm run dev` server, so start that first. See the comment at the top of each script for its options.

To start again from scratch, stop the dev server, delete `.wrangler/state`, and run `npm run db:migrate:local` again.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite + Worker with hot reload |
| `npm run build` | Production build of the client and Worker |
| `npm run typecheck` | Type-checks the Worker and client projects |
| `npm test` | Runs the Vitest suite inside the Workers runtime |
| `npm run check` | `typecheck` + `test` |
| `npm run db:migrate:local` | Applies D1 migrations to the local database |
| `npm run db:migrate:remote` | Applies D1 migrations to your deployed database |
| `npm run cf-typegen` | Regenerates `worker-configuration.d.ts` from `wrangler.jsonc` |
| `npm run brand` | Re-renders the PNG brand assets from `brand/*.svg` |
| `npm run deploy` | `check`, `build`, remote migrations, then `wrangler deploy` |

## Tests

```sh
npm test
```

Tests live in `test/` and run with `@cloudflare/vitest-pool-workers`, so they exercise real D1 and R2 bindings in workerd. Add a test with every bug fix and every new route.

## Project layout

```
src/
  worker/          Hono Worker: fetch(), email(), scheduled()
    inbound/       email() pipeline: parse, resolve, thread, spam, filters, auto-reply
    outbound/      drafts, sending, scheduled sends
    routes/        /api/* route handlers
    middleware/    sessions, CSRF header check, admin guard
    lib/           crypto, signing, helpers
  client/          React 19 web client (Vite, Tailwind v4, TanStack Query, TipTap)
  shared/          code both sides import: API types (api.ts), ULIDs (ulid.ts)
migrations/        numbered D1 migrations (0001_init.sql, ...)
test/              Vitest suites (Workers runtime)
public/            static assets: favicon, PWA icons, manifest, service worker
brand/             logo SVGs and README/social images
docs/              design spec, setup guide, FAQ, architecture diagram
site/              static landing page
scripts/           dev and build helpers
```

`docs/design.md` is the product spec. The API section in it is the contract between the Worker and the client, and `src/shared/api.ts` holds the matching types. Change both together.

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/), for example `feat(compose): add send-later menu` or `fix(inbound): handle empty subject`.
- **Migrations:** add a new numbered file in `migrations/` (`0002_add_labels.sql`, `0003_...`). **Never edit a migration that has been applied** anywhere; people's databases already ran it. Write a new migration instead.
- **IDs and time:** IDs are ULIDs from `src/shared/ulid.ts` (the only generator). Timestamps are integer epoch milliseconds.
- **Errors:** API errors are `{ "error": { "code": "SNAKE_CASE", "message": "..." } }` with a suitable status.
- **Privacy:** never log message content, addresses or tokens. Invocation logs are off in `wrangler.jsonc`; keep it that way.
- **Security-sensitive code** (auth, sessions, signing, HTML rendering, the image proxy) needs a test, and a note in the PR explaining the change.
- **No new third-party services.** Cirrus runs on Cloudflare primitives only.
