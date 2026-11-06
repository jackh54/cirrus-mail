# App passwords and CardDAV / CalDAV

Migration `0015_dav.sql`. Code: `src/worker/dav/` (protocol), `routes/app-passwords.ts`, `routes/dav-api.ts`, tests in `test/dav.test.ts`.

## App passwords
- `GET/POST /api/app-passwords`, `DELETE /api/app-passwords/:id`. Creating needs the account password (same reauth counter as other security actions).
- 24 random base32 characters (120 bits), shown once as `xxxx-xxxx-...`. Only `sha256(normalised secret)` is stored; case, spaces and hyphens are ignored when checking. Max 25 per user.
- `last_used_at` is written at most once an hour.

## DAV server (`/dav/`)
- Basic auth only: login email + app password. The account password and the session cookie are never read on `/dav`. Disabled users and revoked passwords fail.
- Failed attempts are counted per IP (30 / 15 min) in `rate_limits`; over the limit answers 429. Failures are also counted per username, but only for observability: that count never blocks, so nobody can lock a user's sync out by guessing at their address, and a correct app password (120 bits) always works from an IP that is under its limit. Only failures count.
- Layout: `/dav/` -> `/dav/principals/<userId>/` -> `/dav/calendars/<userId>/<slug>/<file>.ics` and `/dav/addressbooks/<userId>/<slug>/<file>.vcf`. Any other user id in the path is a 404.
- `/.well-known/caldav` and `/.well-known/carddav` answer 301 to `/dav/`. `wrangler.jsonc` `run_worker_first` lists `/dav`, `/dav/*` and both well-known paths; `src/worker/index.ts` routes them to `handleDav`, outside the `/api` CSRF middleware.
- Default "Contacts" and "Calendar" are created on the first discovery PROPFIND when the user has none of that kind. MKCALENDAR / MKCOL (with the addressbook resourcetype) create more; DELETE on a collection removes it. Limits: 50 collections per user, 10,000 objects per collection, 256 KB per object (413), 1 MB per XML body (413).
- Methods: OPTIONS, PROPFIND (Depth 0/1, infinity -> 403), PROPPATCH (displayname, calendar-color, descriptions), REPORT (calendar-multiget, calendar-query, addressbook-multiget, addressbook-query, sync-collection; on the principal, home or `/dav/principals/`: `expand-property` and `principal-property-search`, which Apple clients send), MKCOL, MKCALENDAR, GET, HEAD, PUT, DELETE. COPY, MOVE and LOCK are 405.
- XML: own strict parser (`dav/xml.ts`). `<!DOCTYPE` / `<!ENTITY` are rejected with 400, only the five predefined and numeric entities exist, depth/node/attribute caps apply.
- Etags are the sha256 of the stored text. PUT honours `If-Match` and `If-None-Match` (412). DELETE honours `If-Match`. The precondition is part of the write statement (`UPDATE ... WHERE etag IN (...)`, or an upsert whose `DO UPDATE` carries `WHERE`), and the revision bump and change-log rows run only when the write changed a row (`changes() > 0`). Two writers with the same `If-Match` therefore cannot both succeed: the loser gets 412 and nothing is logged.
- The principal answers `calendar-user-address-set` (`mailto:` the login email and the addresses of the user's mailboxes), `principal-URL` and `supported-report-set`. `expand-property` returns `calendar-home-set`, `addressbook-home-set`, `principal-URL` and `displayname` without nested expansion; `calendar-proxy-*-for` and `group-membership` expand to empty. `principal-property-search` returns only the signed-in user, and only when the search term is contained in their email or display name.
- Changing the account password (`POST /api/me/password`) deletes all of the user's app passwords by default (`revokeCredentials: false` keeps them), so sync clients must be given a new app password. An admin password reset does not touch app passwords.

## Sync
`dav_collections.rev` is the CTag. The sync token is `urn:cirrus:sync:<collectionId>:<rev>`. Every write bumps `rev` and appends a `dav_changes` row in the same D1 batch. The hourly cron deletes change rows older than 30 days and records the highest pruned rev in `pruned_rev`; older, foreign or future tokens get `403` with `<D:valid-sync-token/>`, which makes clients do a full resync.

## calendar-query
Objects store `dtstart`, `dtend`, `component`, `recurring`, `rec_until` and `approx`. Over-inclusion is allowed, under-inclusion is not:
- Recurring resources are in if the first start is before the range end and `rec_until` (UNTIL, or COUNT without BYxxx bounded by `COUNT * INTERVAL * period`) is NULL or after the range start. RDATE, COUNT with BYxxx, and open rules are unbounded.
- Floating, all-day and unknown-zone times are treated as UTC and padded by 15 h. TZID values the runtime knows (IANA names) are converted exactly.
- Only the component and time-range parts of a filter are applied. `prop-filter` / `text-match` are ignored (returns a superset). `addressbook-query` returns everything.

## JSON API (`/api/dav/...`, session auth)
- `GET /collections`
- `GET|POST /contacts`, `GET|PUT|DELETE /contacts/:id` (`ContactView` / `ContactInput`). `?q=` searches name and email. Edits only rewrite FN/N, EMAIL, TEL, ORG and NOTE, and only the ones that changed, so other properties, groups and the card's VERSION survive. New cards are vCard 4.0.
- `GET /events?from=&to=&calendar=`, `POST /events`, `GET|PUT|DELETE /events/:id` (`EventView` / `EventInput`). Recurring masters come back once with their `rrule`; the client expands. All-day `end` is exclusive (iCalendar semantics). Edits touch only the changed fields of the master VEVENT, bump SEQUENCE and keep alarms, time zones and unknown properties.
- `PUT`/`DELETE` accept an `If-Match` etag header (412 on mismatch).
- `GET /api/contacts?q=` (autocomplete) now also returns address-book emails after the usage-ranked ones, without duplicates.

## Settings
Settings -> Security has "App passwords" and "Sync contacts & calendars" (server URL, username, steps, and an Apple `.mobileconfig` built in the browser with CardDAV + CalDAV payloads and no password).

## Not covered
Scheduling (iTIP), free-busy, ACL / sharing, VJOURNAL, `addressbook-query` filters, and partial retrieval (`calendar-data` sub-elements) are not implemented.
