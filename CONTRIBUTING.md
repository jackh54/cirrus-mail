# Contributing to Cirrus Mail

Thanks for helping. Bug reports, fixes, docs and features are all welcome.

## Before you start

- **Bugs:** open an issue with the bug report template. Steps to reproduce help most.
- **Features:** open a feature request first for anything bigger than a small fix, so we can agree on the shape before you write code. Check the roadmap in the [README](README.md#roadmap) and the scope in [docs/design.md](docs/design.md).
- **Security issues:** don't open a public issue. See [SECURITY.md](SECURITY.md).

Cirrus deliberately has **no bulk-mail or marketing features**. Pull requests that add them won't be accepted.

## Setting up

```sh
git clone https://github.com/jackh54/cirrus-mail.git
cd cirrus-mail
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

[docs/development.md](docs/development.md) covers demo data, test mail, the project layout and the scripts.

## Making a change

1. Fork the repository and create a branch from `main`, for example `fix/thread-subject-prefix`.
2. Make your change. Keep each pull request focused on one thing.
3. Add or update tests in `test/`.
4. Run the checks:
   ```sh
   npm run typecheck
   npm test
   npm run build
   ```
5. Update the docs if behaviour, configuration or setup steps change.
6. Open a pull request and fill in the template.

## Conventions

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(compose): ...`, `fix(inbound): ...`, `docs: ...`, `test: ...`, `chore: ...`.
- **The API contract** lives in `docs/design.md` §5 and `src/shared/api.ts`. If you change an endpoint, update both, and update the Worker and the client together.
- **D1 migrations** are numbered files in `migrations/`. Add a new one for every schema change. **Never edit a migration that has already been applied**; write a new one instead.
- **IDs** come from `src/shared/ulid.ts`. Timestamps are epoch milliseconds.
- **No logging of message content**, addresses, tokens or secrets.
- **No new third-party services or runtime dependencies** without discussing it in an issue first.
- **Security-sensitive changes** (auth, sessions, signing, HTML rendering, the proxy) need tests and a short explanation in the pull request.

## Reviews

A maintainer reviews every pull request. CI must pass (typecheck, tests, build). Expect questions; they're about the code, never about you.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), and you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
