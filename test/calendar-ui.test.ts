import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DavCollectionInfo, EventView, InvitePreview, Page } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import { hashPassword } from '../src/worker/lib/crypto';
import { call, sessionCookie } from './helpers';

const PASSWORD = 'admin-password-123';
let cookie = '';
let other = '';

async function mkUser(email: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
    .bind(id, email, email.split('@')[0], await hashPassword(PASSWORD), 'member', now, now).run();
  return id;
}

const login = async (email: string) => sessionCookie(await call('/api/auth/login', { body: { email, password: PASSWORD } }));

beforeAll(async () => {
  await mkUser('cal-a@calui.test');
  await mkUser('cal-b@calui.test');
  cookie = await login('cal-a@calui.test');
  other = await login('cal-b@calui.test');
});

const invite = (uid: string, summary: string, extra: string[] = [], method = 'REQUEST') => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', `METHOD:${method}`,
  'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260301T000000Z', 'DTSTART:20260310T140000Z', 'DTEND:20260310T150000Z', `SUMMARY:${summary}`,
  'LOCATION:Room 4', 'ORGANIZER;CN=Grace Hopper:mailto:Grace@Navy.test', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:cal-a@calui.test', ...extra,
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

describe('calendar collections API', () => {
  it('creates, recolours and renames a calendar', async () => {
    const res = await call('/api/dav/collections', { cookie, body: { kind: 'calendar', name: 'Work', color: '#2B63E8' } });
    expect(res.status).toBe(201);
    const made = (await res.json()) as DavCollectionInfo;
    expect(made).toMatchObject({ kind: 'calendar', name: 'Work', color: '#2B63E8' });

    const patched = await call(`/api/dav/collections/${made.id}`, { method: 'PATCH', cookie, body: { name: 'Work stuff', color: '#1A8F5C' } });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id: made.id, name: 'Work stuff', color: '#1A8F5C' });

    // A partial patch leaves the other field alone.
    const onlyName = (await (await call(`/api/dav/collections/${made.id}`, { method: 'PATCH', cookie, body: { name: 'Work' } })).json()) as DavCollectionInfo;
    expect(onlyName).toMatchObject({ name: 'Work', color: '#1A8F5C' });

    const list = (await (await call('/api/dav/collections', { cookie })).json()) as DavCollectionInfo[];
    expect(list.filter((c) => c.kind === 'calendar').map((c) => c.name)).toContain('Work');
  });

  it('rejects bad colours and other users', async () => {
    expect((await call('/api/dav/collections', { cookie, body: { kind: 'calendar', name: 'x', color: 'red' } })).status).toBe(400);
    expect((await call('/api/dav/collections', { cookie, body: { kind: 'calendar', name: '', color: null } })).status).toBe(400);
    const made = (await (await call('/api/dav/collections', { cookie, body: { kind: 'addressbook', name: 'Friends' } })).json()) as DavCollectionInfo;
    expect(made.kind).toBe('addressbook');
    expect((await call(`/api/dav/collections/${made.id}`, { method: 'PATCH', cookie: other, body: { name: 'mine now' } })).status).toBe(404);
  });
});

describe('invitations', () => {
  it('previews an invitation and finds no existing copy', async () => {
    const res = await call('/api/dav/invite/parse', { cookie, body: { ics: invite('inv-1@test', 'Planning') } });
    expect(res.status).toBe(200);
    const p = (await res.json()) as InvitePreview;
    expect(p).toMatchObject({
      method: 'REQUEST', uid: 'inv-1@test', existing: null, attendees: ['cal-a@calui.test'],
      organizer: { email: 'grace@navy.test', name: 'Grace Hopper' },
      event: { summary: 'Planning', start: '2026-03-10T14:00:00Z', end: '2026-03-10T15:00:00Z', allDay: false, location: 'Room 4' },
    });
  });

  it('adds to the default calendar once and updates by UID afterwards', async () => {
    const first = await call('/api/dav/invite/accept', { cookie, body: { ics: invite('inv-2@test', 'Kickoff') } });
    expect(first.status).toBe(201);
    const ev = (await first.json()) as EventView;
    expect(ev).toMatchObject({ summary: 'Kickoff', uid: 'inv-2@test', start: '2026-03-10T14:00:00Z' });

    const second = await call('/api/dav/invite/accept', { cookie, body: { ics: invite('inv-2@test', 'Kickoff (moved)', ['SEQUENCE:1']) } });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ id: ev.id, summary: 'Kickoff (moved)' });

    const all = (await (await call('/api/dav/events?from=2026-03-01T00:00:00Z&to=2026-03-31T00:00:00Z', { cookie })).json()) as Page<EventView>;
    expect(all.items.filter((e) => e.uid === 'inv-2@test').length).toBe(1);

    const again = (await (await call('/api/dav/invite/parse', { cookie, body: { ics: invite('inv-2@test', 'Kickoff') } })).json()) as InvitePreview;
    expect(again.existing).toEqual({ id: ev.id, calendarId: ev.calendarId });
    // Another user's copy is invisible.
    expect(((await (await call('/api/dav/invite/parse', { cookie: other, body: { ics: invite('inv-2@test', 'Kickoff') } })).json()) as InvitePreview).existing).toBeNull();
  });

  it('refuses cancellations and garbage, and drops rules the API would reject', async () => {
    expect((await call('/api/dav/invite/accept', { cookie, body: { ics: invite('inv-3@test', 'Gone', [], 'CANCEL') } })).status).toBe(400);
    expect((await call('/api/dav/invite/parse', { cookie, body: { ics: 'this is not a calendar file at all' } })).status).toBe(400);
    const odd = await call('/api/dav/invite/accept', { cookie, body: { ics: invite('inv-4@test', 'Odd rule', ['RRULE:FREQ=WEEKLY;BYDAY=MO;X-FOO=a b']) } });
    expect(odd.status).toBe(201);
    expect(((await odd.json()) as EventView).rrule).toBeNull();
  });

  it('requires a session', async () => {
    expect((await call('/api/dav/invite/parse', { body: { ics: invite('inv-5@test', 'x') } })).status).toBe(401);
  });
});
