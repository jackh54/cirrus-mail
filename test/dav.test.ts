import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppPassword, AppPasswordCreateResponse, ContactView, EventView, Page } from '../src/shared/api';
import { ulid } from '../src/shared/ulid';
import { hourlyMaintenance } from '../src/worker/cron';
import { normalizeAppPassword } from '../src/worker/dav/auth';
import { handleDav } from '../src/worker/dav/handler';
import { hashPassword, sha256Hex } from '../src/worker/lib/crypto';
import worker from '../src/worker/index';
import { BASE, call, createMailbox, ctx, sessionCookie } from './helpers';

const PASSWORD = 'admin-password-123';
const A = { id: '', email: 'dav-a@davtest.test', secret: '', auth: '' };
const B = { id: '', email: 'dav-b@davtest.test', secret: '', auth: '' };

const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

async function mkUser(email: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO users (id, email, name, password_hash, role, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
    .bind(id, email, email.split('@')[0], await hashPassword(PASSWORD), 'member', now, now).run();
  return id;
}

async function mkAppPassword(userId: string, name = 'test'): Promise<{ id: string; secret: string }> {
  const secret = ulid().toLowerCase().slice(0, 24);
  const id = ulid();
  await env.DB.prepare('INSERT INTO app_passwords (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, userId, name, await sha256Hex(normalizeAppPassword(secret)), Date.now()).run();
  return { id, secret };
}

interface DavOpts { auth?: string | null; body?: string; headers?: Record<string, string>; ip?: string }

function dav(method: string, path: string, o: DavOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...o.headers };
  const auth = o.auth === undefined ? A.auth : o.auth;
  if (auth) headers.authorization = auth;
  if (o.ip) headers['cf-connecting-ip'] = o.ip;
  if (method === 'MKCALENDAR') {
    // The Request constructor in this test runtime refuses MKCALENDAR, which real HTTP servers do pass through.
    const req = new Request(BASE + path, { method: 'PUT', headers, body: o.body });
    return handleDav(new Proxy(req, { get: (t, k) => (k === 'method' ? 'MKCALENDAR' : (Reflect.get(t, k) as unknown) instanceof Function ? (Reflect.get(t, k) as () => unknown).bind(t) : Reflect.get(t, k)) }), env);
  }
  return worker.fetch(new Request(BASE + path, { method, headers, body: o.body }) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
}

const NS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"';
const propfind = (props: string) => `<?xml version="1.0"?><D:propfind ${NS}><D:prop>${props}</D:prop></D:propfind>`;
const cal = (uid: string, extra: string[] = [], comp = 'VEVENT') =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', `BEGIN:${comp}`, `UID:${uid}`, 'DTSTAMP:20260101T000000Z', ...extra, `END:${comp}`, 'END:VCALENDAR', ''].join('\r\n');
const card = (uid: string, fn: string, extra: string[] = []) =>
  ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${fn}`, `N:${fn.split(' ').reverse().join(';')};;;`, ...extra, 'END:VCARD', ''].join('\r\n');

const hrefs = (xml: string) => [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
const responses = (xml: string) => xml.split('<D:response>').slice(1);
const etagOf = (res: Response) => res.headers.get('etag')!;

let calPath = '';
let abPath = '';

beforeAll(async () => {
  A.id = await mkUser(A.email);
  B.id = await mkUser(B.email);
  A.secret = (await mkAppPassword(A.id)).secret;
  B.secret = (await mkAppPassword(B.id)).secret;
  A.auth = basic(A.email, A.secret);
  B.auth = basic(B.email, B.secret);
  calPath = `/dav/calendars/${A.id}/calendar/`;
  abPath = `/dav/addressbooks/${A.id}/contacts/`;
  // Lazily creates the default collections.
  await dav('PROPFIND', `/dav/calendars/${A.id}/`, { headers: { depth: '1' } });
});

describe('DAV Basic auth', () => {
  it('accepts an app password, in any case and with separators', async () => {
    expect((await dav('PROPFIND', '/dav/', { headers: { depth: '0' } })).status).toBe(207);
    const grouped = A.secret.toUpperCase().replace(/(.{4})/g, '$1-');
    expect((await dav('PROPFIND', '/dav/', { auth: basic(A.email.toUpperCase(), grouped), headers: { depth: '0' } })).status).toBe(207);
  });

  it('rejects the real login password, a wrong user and missing credentials', async () => {
    const real = await dav('PROPFIND', '/dav/', { auth: basic(A.email, PASSWORD) });
    expect(real.status).toBe(401);
    expect(real.headers.get('www-authenticate')).toMatch(/^Basic /);
    expect((await dav('PROPFIND', '/dav/', { auth: basic(B.email, A.secret) })).status).toBe(401);
    expect((await dav('PROPFIND', '/dav/', { auth: null })).status).toBe(401);
    expect((await dav('PROPFIND', '/dav/', { auth: 'Basic !!!' })).status).toBe(401);
  });

  it('rejects a revoked app password and a disabled user', async () => {
    const extra = await mkAppPassword(A.id, 'temp');
    const auth = basic(A.email, extra.secret);
    expect((await dav('PROPFIND', '/dav/', { auth, headers: { depth: '0' } })).status).toBe(207);
    await env.DB.prepare('DELETE FROM app_passwords WHERE id = ?').bind(extra.id).run();
    expect((await dav('PROPFIND', '/dav/', { auth })).status).toBe(401);

    await env.DB.prepare('UPDATE users SET disabled = 1 WHERE id = ?').bind(B.id).run();
    expect((await dav('PROPFIND', '/dav/', { auth: B.auth })).status).toBe(401);
    await env.DB.prepare('UPDATE users SET disabled = 0 WHERE id = ?').bind(B.id).run();
    expect((await dav('PROPFIND', '/dav/', { auth: B.auth, headers: { depth: '0' } })).status).toBe(207);
  });

  it('rate-limits failed attempts per IP, but never locks a username out', async () => {
    const u = await mkUser('dav-rl@davtest.test');
    const good = basic('dav-rl@davtest.test', (await mkAppPassword(u)).secret);
    for (let i = 0; i < 10; i++) expect((await dav('PROPFIND', '/dav/', { auth: basic('dav-rl@davtest.test', `wrong${i}`), ip: '10.1.1.1' })).status).toBe(401);
    // Failures are counted for the username, but they never block the right app password, from any address.
    expect((await dav('PROPFIND', '/dav/', { auth: good, ip: '10.1.1.2', headers: { depth: '0' } })).status).toBe(207);
    expect((await dav('PROPFIND', '/dav/', { auth: good, ip: '10.1.1.1', headers: { depth: '0' } })).status).toBe(207);
    expect((await dav('PROPFIND', '/dav/', { auth: basic('dav-rl@davtest.test', 'still-wrong'), ip: '10.1.1.3' })).status).toBe(401);

    for (let i = 0; i < 30; i++) await dav('PROPFIND', '/dav/', { auth: basic(`nobody${i}@davtest.test`, 'x'), ip: '10.2.2.2' });
    const blocked = await dav('PROPFIND', '/dav/', { auth: A.auth, ip: '10.2.2.2' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('ignores the session cookie', async () => {
    const login = await call('/api/auth/login', { body: { email: A.email, password: PASSWORD } });
    const cookie = sessionCookie(login);
    const res = await dav('PROPFIND', '/dav/', { auth: null, headers: { cookie } });
    expect(res.status).toBe(401);
    expect((await dav('GET', `${calPath}x.ics`, { auth: null, headers: { cookie } })).status).toBe(401);
  });

  it('answers OPTIONS with the DAV classes and no auth', async () => {
    const res = await dav('OPTIONS', '/dav/', { auth: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('dav')).toBe('1, 3, addressbook, calendar-access');
    expect(res.headers.get('allow')).toContain('MKCALENDAR');
  });
});

describe('discovery', () => {
  it('redirects the well-known URLs', async () => {
    for (const p of ['/.well-known/caldav', '/.well-known/carddav']) {
      const res = await dav('GET', p, { auth: null });
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('/dav/');
    }
  });

  it('walks root -> principal -> home -> collections', async () => {
    const root = await dav('PROPFIND', '/dav/', { headers: { depth: '0' }, body: propfind('<D:current-user-principal/><D:resourcetype/>') });
    expect(root.status).toBe(207);
    expect(root.headers.get('dav')).toContain('calendar-access');
    const rootXml = await root.text();
    expect(rootXml).toContain(`<D:current-user-principal><D:href>/dav/principals/${A.id}/</D:href>`);

    const principal = await (await dav('PROPFIND', `/dav/principals/${A.id}/`, {
      headers: { depth: '0' }, body: propfind('<C:calendar-home-set/><CR:addressbook-home-set/><D:displayname/>'),
    })).text();
    expect(principal).toContain(`<C:calendar-home-set><D:href>/dav/calendars/${A.id}/</D:href>`);
    expect(principal).toContain(`<CR:addressbook-home-set><D:href>/dav/addressbooks/${A.id}/</D:href>`);

    const calHome = await (await dav('PROPFIND', `/dav/calendars/${A.id}/`, {
      headers: { depth: '1' },
      body: propfind('<D:resourcetype/><D:displayname/><CS:getctag/><D:sync-token/><C:supported-calendar-component-set/><A:calendar-color/><D:current-user-privilege-set/>'),
    })).text();
    expect(hrefs(calHome)).toContain(calPath);
    expect(calHome).toContain('<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>');
    expect(calHome).toContain('<C:comp name="VEVENT"/>');
    expect(calHome).toContain('<CS:getctag>');
    expect(calHome).toContain('<D:sync-token>urn:cirrus:sync:');
    // calendar-color is unset: reported as not found rather than invented
    expect(calHome).toContain('HTTP/1.1 404 Not Found');

    const abHome = await (await dav('PROPFIND', `/dav/addressbooks/${A.id}/`, { headers: { depth: '1' }, body: propfind('<D:resourcetype/>') })).text();
    expect(hrefs(abHome)).toContain(abPath);
    expect(abHome).toContain('<CR:addressbook/>');
  });

  it('answers the principal properties Apple clients ask for', async () => {
    const mbox = `${ulid().toLowerCase()}@principal.test`;
    await createMailbox(mbox, [{ userId: A.id }]);
    const xml = await (await dav('PROPFIND', `/dav/principals/${A.id}/`, {
      headers: { depth: '0' }, body: propfind('<C:calendar-user-address-set/><D:principal-URL/><D:supported-report-set/>'),
    })).text();
    expect(xml).toContain(`<D:href>mailto:${A.email}</D:href>`);
    expect(xml).toContain(`<D:href>mailto:${mbox}</D:href>`);
    expect(xml).toContain(`<D:principal-URL><D:href>/dav/principals/${A.id}/</D:href>`);
    expect(xml).toContain('<D:expand-property/>');
    expect(xml).toContain('<D:principal-property-search/>');
    expect(xml).not.toContain('404 Not Found');
  });

  it('rejects Depth: infinity', async () => {
    const res = await dav('PROPFIND', '/dav/', { headers: { depth: 'infinity' } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('propfind-finite-depth');
  });
});

describe('objects', () => {
  it('PUT/GET/DELETE with etags and preconditions', async () => {
    const path = `${calPath}etag1.ics`;
    const body = cal('etag1', ['DTSTART:20260310T100000Z', 'DTEND:20260310T110000Z', 'SUMMARY:One']);
    const created = await dav('PUT', path, { body, headers: { 'if-none-match': '*', 'content-type': 'text/calendar' } });
    expect(created.status).toBe(201);
    const e1 = etagOf(created);
    expect(e1).toMatch(/^"[0-9a-f]{64}"$/);

    const got = await dav('GET', path);
    expect(got.status).toBe(200);
    expect(etagOf(got)).toBe(e1);
    expect(got.headers.get('content-type')).toContain('text/calendar');
    expect(await got.text()).toBe(body);

    // creating over an existing resource, and updating with a stale etag
    expect((await dav('PUT', path, { body, headers: { 'if-none-match': '*' } })).status).toBe(412);
    expect((await dav('PUT', path, { body, headers: { 'if-match': '"nope"' } })).status).toBe(412);
    expect((await dav('PUT', `${calPath}missing.ics`, { body: cal('missing'), headers: { 'if-match': '"x"' } })).status).toBe(412);

    const updated = await dav('PUT', path, { body: body.replace('One', 'Two'), headers: { 'if-match': e1 } });
    expect(updated.status).toBe(204);
    const e2 = etagOf(updated);
    expect(e2).not.toBe(e1);

    expect((await dav('DELETE', path, { headers: { 'if-match': e1 } })).status).toBe(412);
    expect((await dav('GET', path)).status).toBe(200);
    expect((await dav('DELETE', path, { headers: { 'if-match': e2 } })).status).toBe(204);
    expect((await dav('GET', path)).status).toBe(404);
    expect((await dav('DELETE', path)).status).toBe(404);
  });

  it('conditional writes are atomic: concurrent writers with the same precondition cannot both win', async () => {
    const rev = async () => (await env.DB.prepare("SELECT rev FROM dav_collections WHERE user_id = ? AND kind = 'calendar' AND slug = 'calendar'").bind(A.id).first<number>('rev'))!;
    const changes = async (uri: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM dav_changes c JOIN dav_collections k ON k.id = c.collection_id WHERE k.user_id = ? AND c.uri = ?').bind(A.id, uri).first<number>('n'))!;
    const status = (rs: Response[]) => rs.map((r) => r.status).sort();

    // Two creates with If-None-Match: *
    const path = `${calPath}race1.ics`;
    const creates = await Promise.all(['One', 'Two'].map((n) => dav('PUT', path, { body: cal('race1', [`SUMMARY:${n}`]), headers: { 'if-none-match': '*' } })));
    expect(status(creates)).toEqual([201, 412]);
    expect(await changes('race1.ics')).toBe(1);

    // Two updates carrying the same If-Match
    const e1 = etagOf(await dav('GET', path));
    const rev0 = await rev();
    const updates = await Promise.all(['Three', 'Four'].map((n) => dav('PUT', path, { body: cal('race1', [`SUMMARY:${n}`]), headers: { 'if-match': e1 } })));
    expect(status(updates)).toEqual([204, 412]);
    expect(await rev()).toBe(rev0 + 1);
    expect(await changes('race1.ics')).toBe(2);

    // Two deletes carrying the same If-Match
    const e2 = etagOf(await dav('GET', path));
    const dels = await Promise.all([1, 2].map(() => dav('DELETE', path, { headers: { 'if-match': e2 } })));
    expect(status(dels)).toEqual([204, 404]);
    expect(await changes('race1.ics')).toBe(3);

    // If-Match on a missing resource still never creates it
    expect((await dav('PUT', path, { body: cal('race1'), headers: { 'if-match': '*' } })).status).toBe(412);
    expect((await dav('GET', path)).status).toBe(404);
  });

  it('rejects invalid data, uid clashes and oversized bodies', async () => {
    const bad = await dav('PUT', `${calPath}bad.ics`, { body: 'not a calendar' });
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain('valid-calendar-data');
    expect((await dav('PUT', `${abPath}bad.vcf`, { body: cal('x') })).status).toBe(403);

    await dav('PUT', `${calPath}clash1.ics`, { body: cal('clash', ['DTSTART:20260310T100000Z']) });
    const clash = await dav('PUT', `${calPath}clash2.ics`, { body: cal('clash', ['DTSTART:20260310T100000Z']) });
    expect(clash.status).toBe(403);
    expect(await clash.text()).toContain('no-uid-conflict');

    const huge = cal('huge', ['DTSTART:20260310T100000Z', `DESCRIPTION:${'x'.repeat(300 * 1024)}`]);
    expect((await dav('PUT', `${calPath}huge.ics`, { body: huge })).status).toBe(413);
  });

  it('stores vCards and returns them', async () => {
    const body = card('card-1', 'Grace Hopper', ['EMAIL;type=INTERNET:grace@navy.test']);
    expect((await dav('PUT', `${abPath}grace.vcf`, { body })).status).toBe(201);
    const res = await dav('GET', `${abPath}grace.vcf`);
    expect(res.headers.get('content-type')).toContain('text/vcard');
    expect(await res.text()).toBe(body);
  });
});

describe('REPORT', () => {
  const q = (props: string, filter: string) => `<?xml version="1.0"?><C:calendar-query ${NS}><D:prop>${props}</D:prop>${filter}</C:calendar-query>`;
  const range = (start: string, end: string) =>
    `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${start}" end="${end}"/></C:comp-filter></C:comp-filter></C:filter>`;

  it('calendar-query filters by time range, including recurring events', async () => {
    const put = (n: string, extra: string[]) => dav('PUT', `${calPath}${n}.ics`, { body: cal(n, extra) });
    await put('q-single-mar', ['DTSTART:20260310T100000Z', 'DTEND:20260310T110000Z']);
    await put('q-single-may', ['DTSTART:20260510T100000Z', 'DTEND:20260510T110000Z']);
    await put('q-weekly', ['DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z', 'RRULE:FREQ=WEEKLY']);
    await put('q-until', ['DTSTART:20260105T090000Z', 'DTEND:20260105T100000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20260201T000000Z']);
    await put('q-count', ['DTSTART:20260101T090000Z', 'DTEND:20260101T100000Z', 'RRULE:FREQ=DAILY;COUNT=3']);
    await put('q-allday', ['DTSTART;VALUE=DATE:20260315', 'DTEND;VALUE=DATE:20260316']);
    await put('q-future', ['DTSTART:20270101T090000Z', 'DTEND:20270101T100000Z', 'RRULE:FREQ=YEARLY']);
    await put('q-ny', ['DTSTART;TZID=America/New_York:20260320T200000', 'DTEND;TZID=America/New_York:20260320T210000']);
    await dav('PUT', `${calPath}q-todo.ics`, { body: cal('q-todo', ['DUE:20260312T000000Z'], 'VTODO') });

    const names = async (start: string, end: string, filter = range(start, end)) => {
      const res = await dav('REPORT', calPath, { body: q('<D:getetag/>', filter), headers: { depth: '1' } });
      expect(res.status).toBe(207);
      return hrefs(await res.text()).map((h) => h.replace(calPath, '').replace('.ics', '')).filter((n) => n.startsWith('q-')).sort();
    };

    expect(await names('20260301T000000Z', '20260401T000000Z')).toEqual(['q-allday', 'q-ny', 'q-single-mar', 'q-weekly']);
    expect(await names('20260501T000000Z', '20260601T000000Z')).toEqual(['q-single-may', 'q-weekly']);
    // Before everything: only the event whose first occurrence is after the range is out, and so are the unbounded ones that start later.
    expect(await names('20251201T000000Z', '20251215T000000Z')).toEqual([]);
    // The weekly event is excluded after its UNTIL, the COUNT one after its last day.
    expect(await names('20260115T000000Z', '20260116T000000Z')).toEqual(['q-until', 'q-weekly']);
    expect(await names('20260102T000000Z', '20260103T000000Z')).toEqual(['q-count']);
    // Components are filtered too.
    const todos = await dav('REPORT', calPath, { body: q('<D:getetag/>', '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter></C:filter>') });
    expect(hrefs(await todos.text()).filter((h) => h.includes('q-'))).toEqual([`${calPath}q-todo.ics`]);
    // No time range: everything.
    expect((await names('', '', '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter>')).length).toBe(8);

    // calendar-data is returned when asked for
    const withData = await (await dav('REPORT', calPath, { body: q('<D:getetag/><C:calendar-data/>', range('20260501T000000Z', '20260601T000000Z')) })).text();
    expect(withData).toContain('UID:q-single-may');
  });

  it('multiget returns the listed resources and 404s the rest', async () => {
    const body = `<?xml version="1.0"?><C:calendar-multiget ${NS}><D:prop><D:getetag/><C:calendar-data/></D:prop>` +
      `<D:href>${calPath}q-single-mar.ics</D:href><D:href>${calPath}q-weekly.ics</D:href><D:href>${calPath}nope.ics</D:href><D:href>/dav/calendars/other/calendar/x.ics</D:href></C:calendar-multiget>`;
    const res = await dav('REPORT', calPath, { body });
    expect(res.status).toBe(207);
    const rs = responses(await res.text());
    expect(rs.length).toBe(4);
    expect(rs[0]).toContain('UID:q-single-mar');
    expect(rs[1]).toContain('UID:q-weekly');
    expect(rs[2]).toContain('404 Not Found');
    expect(rs[3]).toContain('404 Not Found');

    const ab = `<?xml version="1.0"?><CR:addressbook-multiget ${NS}><D:prop><D:getetag/><CR:address-data/></D:prop><D:href>${abPath}grace.vcf</D:href></CR:addressbook-multiget>`;
    expect(await (await dav('REPORT', abPath, { body: ab })).text()).toContain('FN:Grace Hopper');
    const all = `<?xml version="1.0"?><CR:addressbook-query ${NS}><D:prop><D:getetag/></D:prop></CR:addressbook-query>`;
    expect(hrefs(await (await dav('REPORT', abPath, { body: all })).text())).toContain(`${abPath}grace.vcf`);
  });

  it('sync-collection reports adds, changes and deletes since a token', async () => {
    const mk = await dav('MKCALENDAR', `/dav/calendars/${A.id}/synctest/`, {
      body: `<?xml version="1.0"?><C:mkcalendar ${NS}><D:set><D:prop><D:displayname>Sync test</D:displayname></D:prop></D:set></C:mkcalendar>`,
    });
    expect(mk.status).toBe(201);
    const path = `/dav/calendars/${A.id}/synctest/`;
    const sync = async (token: string) => {
      const res = await dav('REPORT', path, {
        body: `<?xml version="1.0"?><D:sync-collection ${NS}><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`,
      });
      const xml = await res.text();
      return { res, xml, token: /<D:sync-token>([^<]+)<\/D:sync-token>/.exec(xml)?.[1] ?? '' };
    };
    const put = (n: string, s = 'x') => dav('PUT', `${path}${n}.ics`, { body: cal(n, ['DTSTART:20260310T100000Z', `SUMMARY:${s}`]) });

    await put('a');
    await put('b');
    const first = await sync('');
    expect(first.res.status).toBe(207);
    expect(hrefs(first.xml).filter((h) => h.endsWith('.ics')).sort()).toEqual([`${path}a.ics`, `${path}b.ics`]);
    expect(first.token).toMatch(/^urn:cirrus:sync:/);

    const idle = await sync(first.token);
    expect(responses(idle.xml).length).toBe(0);
    expect(idle.token).toBe(first.token);

    await put('c');
    await put('a', 'changed');
    await dav('DELETE', `${path}b.ics`);
    const next = await sync(first.token);
    const rs = responses(next.xml);
    const byHref = Object.fromEntries(rs.map((r) => [hrefs(r)[0], r]));
    expect(Object.keys(byHref).sort()).toEqual([`${path}a.ics`, `${path}b.ics`, `${path}c.ics`]);
    expect(byHref[`${path}a.ics`]).toContain('<D:getetag>');
    expect(byHref[`${path}c.ics`]).toContain('<D:getetag>');
    expect(byHref[`${path}b.ics`]).toContain('404 Not Found');
    expect(next.token).not.toBe(first.token);

    // garbage, foreign and future tokens force a resync
    for (const bad of ['garbage', `urn:cirrus:sync:${A.id}:1`, `urn:cirrus:sync:${first.token.split(':')[3]}:9999`]) {
      const r = await sync(bad);
      expect(r.res.status).toBe(403);
      expect(r.xml).toContain('valid-sync-token');
    }

    // Collection properties: PROPPATCH, then deletion of the collection.
    const patch = await dav('PROPPATCH', path, {
      body: `<?xml version="1.0"?><D:propertyupdate ${NS}><D:set><D:prop><D:displayname>Renamed</D:displayname><A:calendar-color>#ff0000ff</A:calendar-color></D:prop></D:set></D:propertyupdate>`,
    });
    expect(patch.status).toBe(207);
    expect(await patch.text()).toContain('200 OK');
    const props = await (await dav('PROPFIND', path, { headers: { depth: '0' }, body: propfind('<D:displayname/><A:calendar-color/>') })).text();
    expect(props).toContain('<D:displayname>Renamed</D:displayname>');
    expect(props).toContain('<A:calendar-color>#ff0000ff</A:calendar-color>');
    const denied = await dav('PROPPATCH', path, { body: `<?xml version="1.0"?><D:propertyupdate ${NS}><D:set><D:prop><D:getetag>x</D:getetag></D:prop></D:set></D:propertyupdate>` });
    expect(await denied.text()).toContain('403 Forbidden');

    expect((await dav('MKCALENDAR', path)).status).toBe(405);
    expect((await dav('DELETE', path)).status).toBe(204);
    expect((await dav('PROPFIND', path, { headers: { depth: '0' } })).status).toBe(404);
  });

  it('creates an address book with MKCOL', async () => {
    const path = `/dav/addressbooks/${A.id}/work/`;
    const res = await dav('MKCOL', path, {
      body: `<?xml version="1.0"?><D:mkcol ${NS}><D:set><D:prop><D:resourcetype><D:collection/><CR:addressbook/></D:resourcetype><D:displayname>Work</D:displayname></D:prop></D:set></D:mkcol>`,
    });
    expect(res.status).toBe(201);
    expect(await (await dav('PROPFIND', path, { headers: { depth: '0' }, body: propfind('<D:displayname/>') })).text()).toContain('Work');
    expect((await dav('MKCOL', `/dav/addressbooks/${A.id}/plain/`)).status).toBe(403);
    expect((await dav('DELETE', path)).status).toBe(204);
  });
});

describe('principal REPORTs', () => {
  const pr = () => `/dav/principals/${A.id}/`;
  const davHrefs = (xml: string) => hrefs(xml).filter((h) => h.startsWith('/dav/'));
  const expand = (props: string) => `<?xml version="1.0"?><D:expand-property ${NS}>${props}</D:expand-property>`;
  const search = (term: string, attrs = '', props = '<D:displayname/><C:calendar-user-address-set/>') =>
    `<?xml version="1.0"?><D:principal-property-search ${NS}${attrs}><D:property-search><D:prop><D:displayname/></D:prop><D:match>${term}</D:match></D:property-search><D:prop>${props}</D:prop></D:principal-property-search>`;

  it('expand-property returns the home sets, principal URL and name, and empty proxy lists', async () => {
    const res = await dav('REPORT', pr(), {
      headers: { depth: '0' },
      body: expand(
        '<D:property name="calendar-home-set" namespace="urn:ietf:params:xml:ns:caldav"/><D:property name="addressbook-home-set" namespace="urn:ietf:params:xml:ns:carddav"/>'
        + '<D:property name="principal-URL"/><D:property name="displayname"/>'
        + '<D:property name="calendar-proxy-read-for" namespace="http://calendarserver.org/ns/"><D:property name="displayname"/></D:property>'
        + '<D:property name="calendar-proxy-write-for" namespace="http://calendarserver.org/ns/"/>',
      ),
    });
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(hrefs(xml)[0]).toBe(pr());
    expect(xml).toContain(`<C:calendar-home-set><D:href>/dav/calendars/${A.id}/</D:href>`);
    expect(xml).toContain(`<CR:addressbook-home-set><D:href>/dav/addressbooks/${A.id}/</D:href>`);
    expect(xml).toContain(`<D:principal-URL><D:href>${pr()}</D:href>`);
    expect(xml).toContain('<D:displayname>dav-a</D:displayname>');
    expect(xml).toContain('<CS:calendar-proxy-read-for/>');
    expect(xml).toContain('<CS:calendar-proxy-write-for/>');
    expect(xml).not.toContain('404 Not Found');
    // Also accepted on the calendar home
    expect((await dav('REPORT', `/dav/calendars/${A.id}/`, { headers: { depth: '0' }, body: expand('<D:property name="displayname"/>') })).status).toBe(207);
  });

  it('principal-property-search returns the signed-in user only, when the term matches their email or name', async () => {
    for (const term of ['dav-a', 'DAV-A@davtest', 'davtest.test']) {
      const xml = await (await dav('REPORT', '/dav/principals/', { body: search(term) })).text();
      expect(davHrefs(xml)).toEqual([pr()]);
      expect(xml).toContain(`<D:href>mailto:${A.email}</D:href>`);
    }
    // B's address matches nothing of A's, and a search never reveals another user
    for (const term of ['dav-b', 'nobody-at-all']) {
      const res = await dav('REPORT', '/dav/principals/', { body: search(term) });
      expect(res.status).toBe(207);
      expect(davHrefs(await res.text())).toEqual([]);
    }
    expect(davHrefs(await (await dav('REPORT', pr(), { body: search('dav-a', ' test="anyof"') })).text())).toEqual([pr()]);
    expect(davHrefs(await (await dav('REPORT', pr(), { body: search('zzz', ' test="anyof"') })).text())).toEqual([]);
  });
});

describe('isolation and hardening', () => {
  it("does not expose another user's collections", async () => {
    expect((await dav('PROPFIND', `/dav/calendars/${A.id}/`, { auth: B.auth, headers: { depth: '1' } })).status).toBe(404);
    expect((await dav('PROPFIND', calPath, { auth: B.auth, headers: { depth: '1' } })).status).toBe(404);
    expect((await dav('GET', `${calPath}q-weekly.ics`, { auth: B.auth })).status).toBe(404);
    expect((await dav('PUT', `${calPath}intruder.ics`, { auth: B.auth, body: cal('intruder') })).status).toBe(404);
    expect((await dav('DELETE', `${calPath}q-weekly.ics`, { auth: B.auth })).status).toBe(404);
    expect((await dav('REPORT', calPath, { auth: B.auth, body: `<C:calendar-query ${NS}><D:prop><D:getetag/></D:prop></C:calendar-query>` })).status).toBe(404);
    expect((await dav('PROPFIND', `/dav/principals/${A.id}/`, { auth: B.auth })).status).toBe(404);
    expect((await dav('GET', `${calPath}q-weekly.ics`)).status).toBe(200);
  });

  it('rejects XML with a DOCTYPE or entity declarations', async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><D:propfind xmlns:D="DAV:"><D:prop><D:displayname>&e;</D:displayname></D:prop></D:propfind>`;
    expect((await dav('PROPFIND', '/dav/', { body: xxe, headers: { depth: '0' } })).status).toBe(400);
    const lol = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>`;
    expect((await dav('REPORT', calPath, { body: lol })).status).toBe(400);
    expect((await dav('PROPFIND', '/dav/', { body: '<D:propfind xmlns:D="DAV:"><D:prop>&custom;</D:prop></D:propfind>' })).status).toBe(400);
    expect((await dav('PROPFIND', '/dav/', { body: '<D:propfind xmlns:D="DAV:"><D:prop></D:propfind>' })).status).toBe(400);
    expect((await dav('PROPFIND', '/dav/', { body: '<D:propfind><D:allprop/></D:propfind>' })).status).toBe(400);
  });

  it('caps XML request bodies', async () => {
    const res = await dav('PROPFIND', '/dav/', { body: `<D:propfind xmlns:D="DAV:"><D:prop>${' '.repeat(1024 * 1024 + 10)}</D:prop></D:propfind>` });
    expect(res.status).toBe(413);
  });

  it('answers unsupported methods with 405', async () => {
    expect((await dav('COPY', `${calPath}q-weekly.ics`)).status).toBe(405);
    expect((await dav('LOCK', `${calPath}q-weekly.ics`)).status).toBe(405);
  });
});

describe('app password API', () => {
  it('creates (with reauth), lists, authenticates and revokes', async () => {
    const cookie = sessionCookie(await call('/api/auth/login', { body: { email: B.email, password: PASSWORD } }));
    expect((await call('/api/app-passwords', { body: { name: 'Phone', password: 'wrong-password' }, cookie })).status).toBe(400);
    expect((await call('/api/app-passwords', { body: { name: 'Phone', password: PASSWORD } })).status).toBe(401);

    const res = await call('/api/app-passwords', { body: { name: 'Phone', password: PASSWORD }, cookie });
    expect(res.status).toBe(201);
    const made = (await res.json()) as AppPasswordCreateResponse;
    expect(made.secret).toMatch(/^([a-z2-7]{4}-){5}[a-z2-7]{4}$/);

    const auth = basic(B.email, made.secret);
    expect((await dav('PROPFIND', '/dav/', { auth, headers: { depth: '0' } })).status).toBe(207);

    const list = (await (await call('/api/app-passwords', { cookie })).json()) as AppPassword[];
    const mine = list.find((p) => p.id === made.appPassword.id)!;
    expect(mine.name).toBe('Phone');
    expect(mine.lastUsedAt).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain(made.secret);
    // Only the hash is stored.
    const row = await env.DB.prepare('SELECT token_hash FROM app_passwords WHERE id = ?').bind(made.appPassword.id).first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await sha256Hex(normalizeAppPassword(made.secret)));

    expect((await call(`/api/app-passwords/${made.appPassword.id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect((await dav('PROPFIND', '/dav/', { auth })).status).toBe(401);
    expect((await call(`/api/app-passwords/${made.appPassword.id}`, { method: 'DELETE', cookie })).status).toBe(404);
  });

  it('lets a user with 2FA use app passwords', async () => {
    const u = await mkUser('dav-2fa@davtest.test');
    await env.DB.prepare("UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP' WHERE id = ?").bind(u).run();
    const { secret } = await mkAppPassword(u);
    expect((await dav('PROPFIND', '/dav/', { auth: basic('dav-2fa@davtest.test', secret), headers: { depth: '0' } })).status).toBe(207);
  });
});

describe('JSON API', () => {
  let cookie = '';
  beforeAll(async () => {
    cookie = sessionCookie(await call('/api/auth/login', { body: { email: A.email, password: PASSWORD } }));
  });

  it('round-trips contacts without losing unknown properties', async () => {
    const vcf = card('json-1', 'Ada Lovelace', [
      'item1.EMAIL;type=INTERNET;type=HOME:ada@example.com', 'item1.X-ABLabel:Home', 'TEL;TYPE=CELL:+1 555 0100',
      'X-CUSTOM:keepme', 'PHOTO;ENCODING=b;TYPE=JPEG:AAAA', 'ORG:Analytical Engines;Research',
    ]);
    expect((await dav('PUT', `${abPath}ada.vcf`, { body: vcf })).status).toBe(201);

    const list = (await (await call('/api/dav/contacts?q=lovelace', { cookie })).json()) as Page<ContactView>;
    expect(list.items.length).toBe(1);
    const ada = list.items[0];
    expect(ada.fn).toBe('Ada Lovelace');
    expect(ada.emails).toEqual([{ value: 'ada@example.com', types: ['home'] }]);
    expect(ada.phones[0].value).toBe('+1 555 0100');
    expect(ada.org).toBe('Analytical Engines / Research');

    const { id, etag, updatedAt, addressBookId: _b, ...input } = ada;
    void etag; void updatedAt;
    const res = await call(`/api/dav/contacts/${id}`, { method: 'PUT', cookie, body: { ...input, note: 'Wrote the first program', emails: [...ada.emails, { value: 'ada@work.test', types: ['work'] }] } });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as ContactView;
    expect(updated.note).toBe('Wrote the first program');
    expect(updated.emails.length).toBe(2);

    const stored = await (await dav('GET', `${abPath}ada.vcf`)).text();
    expect(stored).toContain('VERSION:3.0');
    for (const keep of ['X-CUSTOM:keepme', 'PHOTO;ENCODING=b;TYPE=JPEG:AAAA', 'ORG:Analytical Engines;Research', 'TEL;TYPE=CELL:+1 555 0100', 'UID:json-1']) expect(stored).toContain(keep);
    expect(stored).toContain('NOTE:Wrote the first program');
    expect(stored).toContain('ada@work.test');
    // A stale If-Match is refused.
    expect((await call(`/api/dav/contacts/${id}`, { method: 'PUT', cookie, body: input, headers: { 'if-match': '"stale"' } })).status).toBe(412);

    const created = await call('/api/dav/contacts', { cookie, body: { fn: 'Alan Turing', emails: [{ value: 'alan@bletchley.test', types: ['work'] }], phones: [], org: '', note: '' } });
    expect(created.status).toBe(201);
    const alan = (await created.json()) as ContactView;
    expect((await call(`/api/dav/contacts/${alan.id}`, { cookie })).status).toBe(200);
    const raw = (await env.DB.prepare('SELECT data FROM dav_objects WHERE id = ?').bind(alan.id).first<{ data: string }>())!.data;
    expect(raw).toContain('VERSION:4.0');
    expect(raw).toContain('EMAIL;TYPE=work:alan@bletchley.test');
    expect((await call(`/api/dav/contacts/${alan.id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect((await call(`/api/dav/contacts/${alan.id}`, { cookie })).status).toBe(404);

    // Not visible to another user.
    const other = sessionCookie(await call('/api/auth/login', { body: { email: B.email, password: PASSWORD } }));
    expect((await call(`/api/dav/contacts/${id}`, { cookie: other })).status).toBe(404);
    expect((await call(`/api/dav/contacts/${id}`, { method: 'DELETE', cookie: other })).status).toBe(404);
  });

  it('round-trips events', async () => {
    const input = { summary: 'Standup', start: '2026-06-01T09:00:00Z', end: '2026-06-01T09:15:00Z', allDay: false, location: 'Room 1, Floor 2', description: 'Line one\nLine two; ok', rrule: 'FREQ=WEEKLY;BYDAY=MO' };
    const res = await call('/api/dav/events', { cookie, body: input });
    expect(res.status).toBe(201);
    const ev = (await res.json()) as EventView;
    expect(ev).toMatchObject({ ...input, recurring: true });

    const stored = (await env.DB.prepare('SELECT data, uri FROM dav_objects WHERE id = ?').bind(ev.id).first<{ data: string; uri: string }>())!;
    expect(stored.data).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO');
    expect(stored.data).toContain('DTSTART:20260601T090000Z');
    expect(stored.data).toContain('LOCATION:Room 1\\, Floor 2');
    expect((await dav('GET', `${calPath}${stored.uri}`)).status).toBe(200);

    // A client-written event with an unknown property, edited through the API, keeps that property.
    await dav('PUT', `${calPath}client.ics`, { body: cal('client-1', ['DTSTART;VALUE=DATE:20260704', 'DTEND;VALUE=DATE:20260705', 'SUMMARY:Holiday', 'X-APPLE-TRAVEL:keep', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM']) });
    const inRange = (await (await call('/api/dav/events?from=2026-07-01T00:00:00Z&to=2026-07-31T00:00:00Z', { cookie })).json()) as Page<EventView>;
    const holiday = inRange.items.find((e) => e.uid === 'client-1')!;
    expect(holiday).toMatchObject({ allDay: true, start: '2026-07-04', end: '2026-07-05', summary: 'Holiday' });
    expect(inRange.items.some((e) => e.id === ev.id)).toBe(true); // the weekly event overlaps every month after June
    expect((await (await call('/api/dav/events?from=2026-05-01T00:00:00Z&to=2026-05-31T00:00:00Z', { cookie })).json() as Page<EventView>).items.some((e) => e.id === ev.id)).toBe(false);

    const { id, calendarId, uid, etag, recurring, updatedAt, ...rest } = holiday;
    void calendarId; void uid; void etag; void recurring; void updatedAt;
    const put = await call(`/api/dav/events/${id}`, { method: 'PUT', cookie, body: { ...rest, summary: 'Public holiday', end: '2026-07-06' } });
    expect(put.status).toBe(200);
    const after = await (await dav('GET', `${calPath}client.ics`)).text();
    for (const keep of ['X-APPLE-TRAVEL:keep', 'BEGIN:VALARM', 'TRIGGER:-PT15M']) expect(after).toContain(keep);
    expect(after).toContain('SUMMARY:Public holiday');
    expect(after).toContain('DTEND;VALUE=DATE:20260706');
    expect(after).toContain('SEQUENCE:1');

    expect((await call('/api/dav/events', { cookie, body: { ...input, rrule: 'nonsense' } })).status).toBe(400);
    expect((await call('/api/dav/events', { cookie, body: { ...input, start: 'tomorrow' } })).status).toBe(400);
    expect((await call('/api/dav/events', { cookie, body: { ...input, end: '2026-05-01T00:00:00Z' } })).status).toBe(400);
    expect((await call(`/api/dav/events/${ev.id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect((await call(`/api/dav/events/${ev.id}`, { cookie })).status).toBe(404);
  });

  it('merges address-book emails into contact autocomplete without duplicates', async () => {
    await env.DB.prepare('INSERT INTO contacts (id, user_id, email, name, times_used, last_used_at) VALUES (?, ?, ?, ?, 3, ?)')
      .bind(ulid(), A.id, 'grace@navy.test', 'Grace H', Date.now()).run();
    const res = await call('/api/contacts?q=grace', { cookie });
    const list = (await res.json()) as { email: string; name: string }[];
    expect(list.filter((c) => c.email === 'grace@navy.test').length).toBe(1);
    expect(list[0].name).toBe('Grace H');

    const ada = (await (await call('/api/contacts?q=lovelace', { cookie })).json()) as { email: string; name: string }[];
    expect(ada.map((c) => c.email).sort()).toEqual(['ada@example.com', 'ada@work.test']);
    expect(ada[0].name).toBe('Ada Lovelace');
    expect((await (await call('/api/contacts?q=lovelace', { cookie: sessionCookie(await call('/api/auth/login', { body: { email: B.email, password: PASSWORD } })) })).json() as unknown[]).length).toBe(0);
  });
});

describe('change-log pruning', () => {
  it('expires old sync tokens with valid-sync-token', async () => {
    const path = `/dav/calendars/${A.id}/prune/`;
    expect((await dav('MKCALENDAR', path)).status).toBe(201);
    await dav('PUT', `${path}a.ics`, { body: cal('prune-a', ['DTSTART:20260310T100000Z']) });
    const token = /<D:sync-token>([^<]+)</.exec(await (await dav('PROPFIND', path, { headers: { depth: '0' }, body: propfind('<D:sync-token/>') })).text())![1];
    await dav('PUT', `${path}b.ics`, { body: cal('prune-b', ['DTSTART:20260310T100000Z']) });
    const sync = (t: string) => dav('REPORT', path, { body: `<D:sync-collection ${NS}><D:sync-token>${t}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>` });
    expect((await sync(token)).status).toBe(207);

    await hourlyMaintenance(env, Date.now() + 31 * 24 * 3600 * 1000);
    const expired = await sync(token);
    expect(expired.status).toBe(403);
    expect(await expired.text()).toContain('valid-sync-token');
    // A fresh sync still works and hands out a usable token.
    const fresh = await (await sync('')).text();
    expect(hrefs(fresh).filter((h) => h.endsWith('.ics')).length).toBe(2);
  });
});
