# Passkeys (WebAuthn)

## What it does
- Passwordless sign-in with discoverable credentials. LoginPage has conditional-UI autofill (`autocomplete="username webauthn"`) and a "Sign in with a passkey" button.
- Second factor: after a correct password, a user with TOTP may present a passkey instead of the code ("Use a passkey instead"). User verification is requested as `preferred` there.
- Passwordless sign-in requires the UV flag (`userVerification: 'required'`), which counts as multi-factor, so TOTP is skipped.
- Settings > Security > Passkeys: list (name, added, last used), add, rename, delete. The section is hidden when `window.PublicKeyCredential` is missing.

## Schema (`migrations/0010_passkeys.sql`)
- `passkeys`: id, user_id (ON DELETE CASCADE), credential_id (UNIQUE, base64url), public_key (base64url COSE_Key as registered), alg, sign_count, transports, name, created_at, last_used_at.
- `webauthn_challenges`: challenge (PK), purpose (`register`|`login`), user_id (set for register, NULL for login), expires_at. Expired rows are deleted whenever a new challenge is issued; there is no cron job.

## Routes
Pre-auth (`/api/auth/passkey`):
- `POST /options {mfa?}` returns `{options}`; usernameless, so it reveals nothing about any account. 30 per IP per 15 minutes.
- `POST /login {credential}` returns `{user}` and a session cookie. 10 failures per IP and 30 per account per 15 minutes (counted before verification; the IP counter clears and the account hit is returned on success).
- `POST /api/auth/login` accepts an optional `passkey` assertion in place of `totp` (only used when the user has TOTP). Attempts share the `totp:<user>` failure budget (5 per 15 minutes). The credential must belong to the user who gave the password.

Signed-in (`/api/me/passkeys`):
- `GET /`, `PATCH /:id {name}`.
- `POST /options {password}` checks the current password (same `reauth:<user>` limiter as other security changes) and only then issues a registration challenge bound to the user.
- `POST / {credential, name?}` finishes registration. `DELETE /:id {password}` needs the password again.
- Every query is scoped by `user_id`; another user's id answers 404.

## Verification
- Hand-written on WebCrypto (`src/worker/lib/webauthn.ts`, `src/worker/lib/passkeys.ts`), no npm dependency: a minimal CBOR/COSE reader, ES256 (DER to raw r||s), RS256 (2048-bit minimum) and Ed25519.
- Challenges: 32 random bytes, TTL 5 minutes, spent with a conditional `DELETE ... RETURNING`, bound to purpose and (for register) user.
- Checks: clientData type, challenge, origin (equal to the request URL's origin, never a header), `crossOrigin` not true, rpIdHash (RP ID is the request hostname), UP, UV when required, signature over authData || SHA-256(clientDataJSON), user handle (when sent) equal to the owner, credential id equal to rawId.
- Sign count: if either the stored or new count is non-zero, the new one must be strictly greater. The update is conditional, so concurrent replays cannot both pass. Authenticators that always report 0 are fine.
- Attestation is `none`; `attStmt` is ignored (it is never used for trust).
- Every sign-in failure is the same `401 INVALID_CREDENTIALS`. A disabled user gets `403 ACCOUNT_DISABLED` only after the signature verified, like the password path.
- Admin password reset leaves passkeys alone; disabling a user blocks them; deleting a user cascades.

## Decisions and limits
- Libraries not used: installing `@simplewebauthn/*` would have written into the node_modules shared with other worktrees, so this was built directly on WebCrypto. The test suite exercises it with a software authenticator.
- Reauth is checked when the registration challenge is issued, not again at finish (the challenge is single-use, user-bound, and expires in 5 minutes).
- At most 20 passkeys per user.
- The RP ID is the request hostname, so passkeys are tied to the domain the app is served from. Changing the domain invalidates them (users fall back to the password).

## Not verified
- No real browser or authenticator was used; only the software authenticator in `test/passkeys.test.ts` (ES256, RS256, Ed25519). No external WebAuthn test vector.
- Conditional-UI autofill and the browser prompts are untested in a live browser.
