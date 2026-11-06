# OpenPGP (end to end, in the browser)

Migration `0014_pgp.sql`. Client crypto is `openpgp` v6, loaded with a dynamic import (its own ~385 kB chunk, fetched only when someone opens PGP settings, an OpenPGP message, or signs/encrypts). The main chunk grew by about 260 bytes.

## What the server knows

- **Never:** a passphrase, or a plaintext private key. The browser encrypts the private key with the PGP passphrase (separate from the login password) before uploading it. The server stores that armored blob and cannot read it. (It cannot verify that the blob is really encrypted, so a modified client could upload an unprotected key. That only hurts its own user.)
- **Yes:** the public key (it computes the fingerprint itself from the packets, and rejects anything that holds secret key material), the user IDs the client reports, and the keyring.
- The decrypted key lives in one JS variable (`src/client/lib/pgp/session.ts`), never in localStorage, sessionStorage or a query cache. "Lock now", a reload, closing the tab, sign-out or a 401 drops it.

## Tables

- `pgp_keys`: one row per user (`private_key_enc`, `public_key`, `fingerprint`, `addresses`, `revoked`).
- `pgp_keyring`: per user, email to public key, `source` (`manual`, `autocrypt`, `wkd`), timestamps, and `pending_*` columns for a changed key.
- `messages.pgp_mode`: `NULL`, `'mime'` or `'inline'` (see Sending).

## Routes (all require a session; scoped to the caller, so one user can never read or write another's rows)

| Method | Path | Notes |
|---|---|---|
| GET/PUT/DELETE | `/api/pgp/key` | own key. PUT `{ publicKey, privateKey, addresses, revoked? }` |
| GET | `/api/pgp/keyring` | `{ items: PgpKeyringEntry[] }` |
| POST | `/api/pgp/keyring` | manual import. Different key for a known address: `409 KEY_CHANGED` unless `replace: true` |
| POST | `/api/pgp/keyring/wkd` | `{ email }`: server-side Web Key Directory lookup, stored with source `wkd`. 404 when nothing is published. Rate limited (30 per 10 min per user) |
| POST | `/api/pgp/keyring/:id/accept` | promote the pending key |
| DELETE | `/api/pgp/keyring/:id/pending` | ignore the pending key |
| DELETE | `/api/pgp/keyring/:id` | remove |

`PUT /api/mailboxes/:mb/drafts/:id` takes an optional `pgp: 'mime' | 'inline' | null`. `POST` of a draft rejects it.

## A changed key is never swapped silently

Autocrypt and WKD keys that differ from the stored one go to `pending_*` and the Settings keyring shows both fingerprints with "Trust the new key" / "Keep the current key". A manual import of a different key needs an explicit confirmation (`replace`).

## Autocrypt (receiving)

`Autocrypt: addr=...; keydata=...` is parsed at receive time (`parseAutocrypt`, `storeAutocrypt` in `src/worker/lib/`). It is stored for every member of the receiving mailbox only when:

1. the message is not spam and its Authentication-Results (Cloudflare's, the trusted topmost one) show `dmarc=pass` with `aligned` true (the same alignment the AuthBadge uses),
2. exactly one Autocrypt header has `addr` equal to the From address (case-insensitive),
3. no unknown critical attribute, and the keydata is a well-formed public key within 64 KB.

## WKD (lookup)

URL building: lowercase the local part, SHA-1, z-base-32. Tries `https://openpgpkey.<domain>/.well-known/openpgpkey/<domain>/hu/<hash>?l=<local>` and then `https://<domain>/.well-known/openpgpkey/hu/<hash>?l=<local>`. Only those two URL shapes are fetched. Rules: the address is validated (ASCII local part; the domain must be a real DNS name, so no IPs, ports, userinfo, single labels or `.local`/`.internal`-style names), https only, redirects are followed only within the same host (at most 2), 5 s overall timeout, 64 KB cap, auth and rate limit required.

## Reading

Detection (`src/client/lib/pgp/detect.ts`, no openpgp import): PGP/MIME encrypted (a `application/pgp-encrypted` part plus the payload part), inline `-----BEGIN PGP MESSAGE-----`, PGP/MIME `multipart/signed` (a `application/pgp-signature` part) and cleartext `-----BEGIN PGP SIGNED MESSAGE-----`. postal-mime already keeps those parts as attachments and the armored text in the body, so nothing changed in the inbound pipeline's storage.

- Encrypted: "Encrypted message, unlock to read" until the key is unlocked, then decrypted in the browser. A PGP/MIME payload is parsed with postal-mime and rendered through the normal path: HTML goes through `prepareEmail` (DOMPurify) into the sandboxed iframe, otherwise `TextBody`. Decrypted attachments are offered as downloads from blob URLs.
- Signed: verified against the sender's keyring key and your own key. For `multipart/signed` the browser downloads the raw `.eml` and splits out the first part byte for byte.
- Badge (`PgpBadge`, a labelled chip, not the AuthBadge shield): "Signed by <last 16 of fingerprint>" (full fingerprint in the tooltip), "Bad signature", "Unknown key", plus "Encrypted".

## Sending

**Transport used:** raw MIME. `worker-configuration.d.ts` types `SendEmail.send(message: EmailMessage)` and exports `EmailMessage` from `cloudflare:email`, so encrypted mail goes out as proper PGP/MIME (RFC 3156: `multipart/encrypted; protocol="application/pgp-encrypted"` with a `Version: 1` part and an `encrypted.asc` part). `src/worker/outbound/pgpmime.ts` builds it; the armored payload is copied through unchanged.

- Raw sends are one envelope per recipient (`EmailMessage` takes a single `to`). Bcc recipients get the same bytes and there is no Bcc header. If at least one envelope succeeded and a later one fails, the send counts as done and the failure is logged (resending would deliver twice to the rest).
- Sign only uses **inline** PGP: a cleartext-signed text/plain body through the normal builder (no HTML part). This avoids having the browser and server agree byte for byte on a signed MIME part.
- The browser produces the payload: for Encrypt it encrypts `Content-Type: text/plain; charset=utf-8` + the plain-text body (signed first when Sign is on) to every recipient and to yourself. With Bcc recipients the key IDs are hidden (wildcard). The server only validates the shape (`INVALID_PGP` unless it is an armored message, and no HTML) and transports it.
- **Drafts stay plaintext on the server**, exactly as before: autosave keeps saving the editor's HTML and text while you type, so the plaintext of an unsent encrypted message is on the server (in R2, the FTS index and the snippet) until you press Send. At Send the browser overwrites the draft with the armored payload (`pgp_mode` set, snippet "Encrypted message"). After "Undo send" the next save writes the plaintext back. The sent copy in Sent holds only ciphertext.
- Subject, From, To and Cc stay visible in an encrypted message, as in any PGP/MIME mail.
- **Attachments are blocked** when Encrypt or Sign is on (client error before sending, and `PGP_ATTACHMENTS` from the server). They are uploaded to the server in plaintext before the body is sealed, so encrypting them into the PGP/MIME payload would not protect them.
- HTML formatting is dropped (plain text only) and the compose sheet says so.
- Sealed drafts that failed to send reopen showing the ciphertext in the editor ("Edit and retry" does not know the original text). Press Undo send, or send again, from the compose sheet instead.

**Autocrypt (sending):** raw PGP/MIME messages carry `Autocrypt: addr=<from>; keydata=<your public key>` when you have a live key listing the From address. It is not added to ordinary mail, because that goes through the builder's `headers` and I could not confirm which custom headers Email Sending accepts (an unaccepted header would fail every send for users with a key).

## Not in this change

- Publishing your own key over WKD, and an Autocrypt "prefer-encrypt" setting.
- Key expiry/extension, subkey management, passphrase change (export, then re-import a key to change it).
- Searching encrypted mail (the index holds only ciphertext).
