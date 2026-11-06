# Contacts, Calendar and invitations in mail

No migration. Code: `src/client/features/{contacts,calendar}`, `src/client/lib/queries/dav.ts`, `features/mail/InviteCard.tsx`, `src/client/components/App{Switcher,Sidebar}.tsx`. Worker: `routes/dav-api.ts`, `inviteFields` in `dav/ical.ts`. Tests: `test/calendar-ui.test.ts` (endpoints), `test/calendar-logic.test.ts` (recurrence, layout, dates).

## Navigation
- `AppSwitcher` (Mail / Calendar / Contacts) sits at the top of the mail rail and of the Calendar/Contacts sidebar. On phones the sidebar is the left drawer (menu button in each page header).
- Palette: Go to Calendar, New event (`/calendar?new=1`), Go to Contacts, New contact (`/contacts/new`).
- `hotkeys.ts` has no `g` go-to chords, so none were added. Calendar page keys: `t` today, `n` new event, `m`/`w`/`d` views (desktop). Arrow keys move the focused day, Home/End jump within the week.

## Routes
- `/contacts/:contactId?` (`new` creates, `?edit=1` opens the editor). Mail reader menu: "Add to contacts" (`/contacts/new?email=&name=`) or "Edit contact".
- `/calendar?d=YYYY-MM-DD&v=month|week|day|agenda`. Desktop: month/week/day. Phone: agenda (next 30 days) and day.

## New API (session auth, in `dav-api.ts`)
- `POST /api/dav/collections` `{kind, name, color}`, `PATCH /api/dav/collections/:id` `{name?, color?}` (`#RRGGBB`). No delete.
- `POST /api/dav/invite/parse` `{ics}` returns `InvitePreview` (METHOD, UID, event, organiser, attendees, existing copy by UID).
- `POST /api/dav/invite/accept` `{ics, calendarId?}` adds the VEVENT to the default calendar, or updates the copy with the same UID (any of the user's calendars). Only METHOD REQUEST/PUBLISH or none. The stored event is rebuilt from the parsed fields (no attendees, alarms or time zones are kept). An RRULE the API would reject is dropped.

## Invitations
The reader fetches the signed attachment URL (a `text/calendar` part or `.ics`, up to 256 KB) and posts the text to `invite/parse`; the server does the parsing (it already resolves IANA TZIDs). The card shows only for METHOD:REQUEST on inbound mail. Accept / Maybe / Decline create a draft to the organiser, attach an `invite.ics` (METHOD:REPLY, ATTENDEE PARTSTAT) and send it through the normal draft path; Accept also adds the event. The reply carries only UID, SEQUENCE, DTSTART, SUMMARY, ORGANIZER and ATTENDEE.

## Recurrence (client, `calendar/recurrence.ts`)
Expanded for the visible range: FREQ DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, WKST, and BYDAY (plain weekdays, weekly only). Anything else (BYMONTHDAY, BYSETPOS, ordinal BYDAY, HOURLY, RDATE, ...) shows the first occurrence only; the dialog says so and keeps the rule untouched ("Repeats (custom)"). Occurrences keep local wall-clock time across DST. EXDATE and RECURRENCE-ID overrides are not applied (the JSON API returns the master only). Months without the 31st (or Feb 29) are skipped, as in RFC 5545.

## Behaviour notes
- Events fetch a window of four months around the focus month; every cached window is patched optimistically on create/edit/move/delete, then refetched.
- Repeating events are edited as a whole series and cannot be dragged. Dragging (week/day, 15-minute steps) moves timed, non-repeating events with the pointer.
- The event calendar cannot be changed after creation. Calendar visibility is a per-browser preference (`cirrus:hiddenCalendars`).
- Edits send no `If-Match`: last write wins in the web app.
- Contacts load as one list (limit 2000); search and A-Z grouping run on the client.
- Not verified in a browser: layout at each breakpoint, drag, and keyboard flows were checked by type and build only.
