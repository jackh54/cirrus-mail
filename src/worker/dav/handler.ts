// CardDAV (RFC 6352) and CalDAV (RFC 4791) server under /dav/, with sync-collection (RFC 6578).
// Authenticated with Basic auth + app passwords only (see auth.ts); cookies are never read here.
import type { UserRow } from '../lib/db';
import { authenticate } from './auth';
import { parseRangeBound } from './ical';
import {
  createCollection, DavError, deleteCollection, deleteObject, ensureDefaults, getCollection, getObject, listCollections, MAX_OBJECT_BYTES,
  putObject, queryObjects, updateCollection, type CollectionRow, type Kind, type ObjectRow,
} from './store';
import { childOf, esc, parseXml, XmlError, type XNode } from './xml';

const D = 'DAV:';
const C = 'urn:ietf:params:xml:ns:caldav';
const CR = 'urn:ietf:params:xml:ns:carddav';
const CS = 'http://calendarserver.org/ns/';
const A = 'http://apple.com/ns/ical/';
const PREFIX: Record<string, string> = { [D]: 'D', [C]: 'C', [CR]: 'CR', [CS]: 'CS', [A]: 'A' };
const NS_DECLS = `xmlns:D="${D}" xmlns:C="${C}" xmlns:CR="${CR}" xmlns:CS="${CS}" xmlns:A="${A}"`;
const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';

const MAX_XML_BYTES = 1024 * 1024;
const MAX_MULTIGET = 1000;
const URI_RE = /^[A-Za-z0-9._@~+=-]{1,200}$/;

const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCOL, MKCALENDAR';

const dirOf = (k: Kind) => (k === 'calendar' ? 'calendars' : 'addressbooks');
const seg = encodeURIComponent;

type Props = Map<string, string>;
const k = (ns: string, local: string) => `${ns} ${local}`;

function render(key: string, inner: string): string {
  const sp = key.indexOf(' ');
  const ns = key.slice(0, sp), local = key.slice(sp + 1);
  const p = PREFIX[ns];
  const tag = p ? `${p}:${local}` : `x:${local}`;
  const decl = p ? '' : ` xmlns:x="${esc(ns)}"`;
  return inner ? `<${tag}${decl}>${inner}</${tag}>` : `<${tag}${decl}/>`;
}

type PropReq = { mode: 'all' } | { mode: 'names' } | { mode: 'prop'; keys: string[] };

const status = (s: string) => `<D:status>HTTP/1.1 ${s}</D:status>`;
const propstat = (els: string[], s: string) => `<D:propstat><D:prop>${els.join('')}</D:prop>${status(s)}</D:propstat>`;

function propResponse(href: string, props: Props, req: PropReq): string {
  const found: string[] = [], missing: string[] = [];
  if (req.mode === 'names') for (const key of props.keys()) found.push(render(key, ''));
  else if (req.mode === 'all') for (const [key, v] of props) found.push(render(key, v));
  else for (const key of req.keys) {
    const v = props.get(key);
    if (v === undefined) missing.push(render(key, ''));
    else found.push(render(key, v));
  }
  let body = '';
  if (found.length || !missing.length) body += propstat(found, '200 OK');
  if (missing.length) body += propstat(missing, '404 Not Found');
  return `<D:response><D:href>${esc(href)}</D:href>${body}</D:response>`;
}

const multistatus = (responses: string[], extra = '') => `${XML_DECL}<D:multistatus ${NS_DECLS}>${responses.join('')}${extra}</D:multistatus>`;

function xmlResponse(body: string, status = 207): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/xml; charset=utf-8' } });
}

function errorResponse(e: DavError): Response {
  if (!e.precondition) return new Response(null, { status: e.status });
  const [ns, name] = e.precondition;
  const inner = e.href ? `<D:href>${esc(e.href)}</D:href>` : '';
  return xmlResponse(`${XML_DECL}<D:error ${NS_DECLS}>${inner ? `<${ns}:${name}>${inner}</${ns}:${name}>` : `<${ns}:${name}/>`}</D:error>`, e.status);
}

const privilegeSet = () =>
  ['all', 'read', 'write', 'write-properties', 'write-content', 'bind', 'unbind', 'read-current-user-privilege-set']
    .map((p) => `<D:privilege><D:${p}/></D:privilege>`).join('');

const reportSet = (kind: Kind | null) => {
  const r = (ns: string, n: string) => `<D:supported-report><D:report>${render(k(ns, n), '')}</D:report></D:supported-report>`;
  return (kind === 'calendar' ? [r(C, 'calendar-multiget'), r(C, 'calendar-query')] : kind === 'addressbook' ? [r(CR, 'addressbook-multiget'), r(CR, 'addressbook-query')] : [])
    .concat(kind ? [r(D, 'sync-collection')] : []).join('');
};

interface Cx { env: Env; db: D1Database; user: UserRow; request: Request }

// ---------- hrefs ----------

const principalHref = (u: UserRow) => `/dav/principals/${seg(u.id)}/`;
const homeHref = (u: UserRow, kind: Kind) => `/dav/${dirOf(kind)}/${seg(u.id)}/`;
const collHref = (u: UserRow, c: CollectionRow) => `${homeHref(u, c.kind)}${seg(c.slug)}/`;
const objHref = (u: UserRow, c: CollectionRow, uri: string) => `${collHref(u, c)}${seg(uri)}`;
const href = (h: string) => `<D:href>${esc(h)}</D:href>`;

// ---------- property sets ----------

const COLLECTION = '<D:collection/>';

function rootProps(u: UserRow): Props {
  return new Map([
    [k(D, 'resourcetype'), COLLECTION], [k(D, 'displayname'), 'Cirrus Mail'],
    [k(D, 'current-user-principal'), href(principalHref(u))], [k(D, 'principal-collection-set'), href('/dav/principals/')],
    [k(D, 'current-user-privilege-set'), privilegeSet()],
  ]);
}

function principalsProps(u: UserRow): Props {
  return new Map([
    [k(D, 'resourcetype'), COLLECTION], [k(D, 'displayname'), 'Principals'],
    [k(D, 'current-user-principal'), href(principalHref(u))], [k(D, 'current-user-privilege-set'), privilegeSet()],
  ]);
}

function principalProps(u: UserRow): Props {
  return new Map([
    [k(D, 'resourcetype'), `${COLLECTION}<D:principal/>`], [k(D, 'displayname'), esc(u.name)],
    [k(D, 'current-user-principal'), href(principalHref(u))], [k(D, 'principal-URL'), href(principalHref(u))],
    [k(D, 'owner'), href(principalHref(u))],
    [k(C, 'calendar-home-set'), href(homeHref(u, 'calendar'))], [k(CR, 'addressbook-home-set'), href(homeHref(u, 'addressbook'))],
    [k(C, 'calendar-user-address-set'), href(`mailto:${u.email}`)],
    [k(D, 'current-user-privilege-set'), privilegeSet()],
  ]);
}

function homeProps(u: UserRow, kind: Kind): Props {
  return new Map([
    [k(D, 'resourcetype'), COLLECTION], [k(D, 'displayname'), kind === 'calendar' ? 'Calendars' : 'Address books'],
    [k(D, 'owner'), href(principalHref(u))], [k(D, 'current-user-principal'), href(principalHref(u))],
    [k(D, 'current-user-privilege-set'), privilegeSet()],
  ]);
}

const syncToken = (c: CollectionRow) => `urn:cirrus:sync:${c.id}:${c.rev}`;

function collProps(u: UserRow, c: CollectionRow): Props {
  const p: Props = new Map([
    [k(D, 'displayname'), esc(c.displayname)], [k(CS, 'getctag'), String(c.rev)], [k(D, 'sync-token'), syncToken(c)],
    [k(D, 'owner'), href(principalHref(u))], [k(D, 'current-user-principal'), href(principalHref(u))],
    [k(D, 'current-user-privilege-set'), privilegeSet()], [k(D, 'supported-report-set'), reportSet(c.kind)],
  ]);
  if (c.kind === 'calendar') {
    p.set(k(D, 'resourcetype'), `${COLLECTION}<C:calendar/>`);
    p.set(k(C, 'supported-calendar-component-set'), c.components.split(',').filter(Boolean).map((n) => `<C:comp name="${esc(n)}"/>`).join(''));
    p.set(k(C, 'supported-calendar-data'), '<C:calendar-data content-type="text/calendar" version="2.0"/>');
    p.set(k(C, 'max-resource-size'), String(MAX_OBJECT_BYTES));
    if (c.color) p.set(k(A, 'calendar-color'), esc(c.color));
    if (c.description) p.set(k(C, 'calendar-description'), esc(c.description));
  } else {
    p.set(k(D, 'resourcetype'), `${COLLECTION}<CR:addressbook/>`);
    p.set(k(CR, 'supported-address-data'), '<CR:address-data-type content-type="text/vcard" version="3.0"/><CR:address-data-type content-type="text/vcard" version="4.0"/>');
    p.set(k(CR, 'max-resource-size'), String(MAX_OBJECT_BYTES));
    if (c.description) p.set(k(CR, 'addressbook-description'), esc(c.description));
  }
  return p;
}

const contentType = (c: CollectionRow, o: ObjectRow) =>
  c.kind === 'calendar' ? `text/calendar; charset=utf-8${o.component ? `; component=${o.component}` : ''}` : 'text/vcard; charset=utf-8';

function objProps(u: UserRow, c: CollectionRow, o: ObjectRow, wantData: boolean): Props {
  const p: Props = new Map([
    [k(D, 'resourcetype'), ''], [k(D, 'getetag'), `&quot;${o.etag}&quot;`], [k(D, 'getcontenttype'), esc(contentType(c, o))],
    [k(D, 'getcontentlength'), String(o.size)], [k(D, 'getlastmodified'), new Date(o.updated_at).toUTCString()],
    [k(D, 'owner'), href(principalHref(u))], [k(D, 'current-user-privilege-set'), privilegeSet()],
  ]);
  if (wantData && o.data !== undefined) p.set(c.kind === 'calendar' ? k(C, 'calendar-data') : k(CR, 'address-data'), esc(o.data));
  return p;
}

const isDataKey = (key: string) => key === k(C, 'calendar-data') || key === k(CR, 'address-data');

// ---------- request parsing ----------

async function readText(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get('content-length'));
  if (declared > max) throw new DavError(413);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new DavError(413);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

const requestedKeys = (prop: XNode | undefined): string[] => (prop ? prop.children.map((n) => k(n.ns, n.name)) : []);

function parsePropfind(body: string): PropReq {
  if (!body.trim()) return { mode: 'all' };
  const root = parseXml(body);
  if (root.ns !== D || root.name !== 'propfind') throw new XmlError('Expected propfind');
  if (childOf(root, D, 'propname')) return { mode: 'names' };
  const prop = childOf(root, D, 'prop');
  if (prop) return { mode: 'prop', keys: requestedKeys(prop) };
  return { mode: 'all' };
}

type Target =
  | { t: 'root' } | { t: 'principals' } | { t: 'principal' } | { t: 'home'; kind: Kind }
  | { t: 'coll'; coll: CollectionRow } | { t: 'newcoll'; kind: Kind; slug: string }
  | { t: 'obj'; coll: CollectionRow; uri: string } | { t: 'none' };

async function resolve(cx: Cx, segs: string[]): Promise<Target> {
  if (!segs.length) return { t: 'root' };
  const [dir, id, ...rest] = segs;
  if (dir === 'principals') return !id ? { t: 'principals' } : id === cx.user.id && !rest.length ? { t: 'principal' } : { t: 'none' };
  const kind: Kind | null = dir === 'calendars' ? 'calendar' : dir === 'addressbooks' ? 'addressbook' : null;
  // Another user's id (or any unknown id) is a plain 404: no existence oracle.
  if (!kind || id !== cx.user.id || rest.length > 2) return { t: 'none' };
  if (!rest.length) return { t: 'home', kind };
  const coll = await getCollection(cx.db, cx.user.id, kind, rest[0]);
  if (rest.length === 1) return coll ? { t: 'coll', coll } : { t: 'newcoll', kind, slug: rest[0] };
  if (!coll || !URI_RE.test(rest[1])) return { t: 'none' };
  return { t: 'obj', coll, uri: rest[1] };
}

// ---------- methods ----------

async function propfind(cx: Cx, target: Target): Promise<Response> {
  const depth = cx.request.headers.get('depth')?.trim().toLowerCase();
  if (depth === 'infinity') throw new DavError(403, ['D', 'propfind-finite-depth']);
  const req = parsePropfind(await readText(cx.request, MAX_XML_BYTES));
  const wantData = req.mode === 'prop' && req.keys.some(isDataKey);
  const u = cx.user;
  const deep = depth === '1';
  const out: string[] = [];
  const add = (h: string, p: Props) => out.push(propResponse(h, p, req));
  switch (target.t) {
    case 'root':
      await ensureDefaults(cx.db, u.id);
      add('/dav/', rootProps(u));
      if (deep) add(principalHref(u), principalProps(u));
      break;
    case 'principals':
      add('/dav/principals/', principalsProps(u));
      if (deep) add(principalHref(u), principalProps(u));
      break;
    case 'principal':
      await ensureDefaults(cx.db, u.id);
      add(principalHref(u), principalProps(u));
      break;
    case 'home': {
      await ensureDefaults(cx.db, u.id);
      add(homeHref(u, target.kind), homeProps(u, target.kind));
      if (deep) for (const c of await listCollections(cx.db, u.id, target.kind)) add(collHref(u, c), collProps(u, c));
      break;
    }
    case 'coll':
      add(collHref(u, target.coll), collProps(u, target.coll));
      if (deep) for (const o of await queryObjects(cx.db, target.coll.id, { withData: wantData })) add(objHref(u, target.coll, o.uri), objProps(u, target.coll, o, wantData));
      break;
    case 'obj': {
      const o = await getObject(cx.db, target.coll.id, target.uri, wantData);
      if (!o) throw new DavError(404);
      add(objHref(u, target.coll, o.uri), objProps(u, target.coll, o, wantData));
      break;
    }
    default:
      throw new DavError(404);
  }
  return xmlResponse(multistatus(out));
}

function parseReportProps(root: XNode): PropReq {
  return { mode: 'prop', keys: requestedKeys(childOf(root, D, 'prop')) };
}

function filterOf(root: XNode): { component: string | null; start: number | null; end: number | null; none: boolean } {
  const out = { component: null as string | null, start: null as number | null, end: null as number | null, none: false };
  const top = childOf(childOf(root, C, 'filter') ?? ({ children: [] } as unknown as XNode), C, 'comp-filter');
  const inner = top && childOf(top, C, 'comp-filter');
  if (!inner) return out;
  const name = (inner.attrs.name ?? '').toUpperCase();
  if (name === 'VEVENT' || name === 'VTODO') out.component = name;
  else if (name) out.none = true;
  const tr = childOf(inner, C, 'time-range');
  if (tr) {
    out.start = parseRangeBound(tr.attrs.start);
    out.end = parseRangeBound(tr.attrs.end);
    if (Number.isNaN(out.start) || Number.isNaN(out.end)) throw new DavError(400);
  }
  return out;
}

function hrefToUri(h: string, prefix: string): string | null {
  let path = h.trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
    if (!path.startsWith(prefix)) return null;
    const uri = decodeURIComponent(path.slice(prefix.length));
    return URI_RE.test(uri) ? uri : null;
  } catch {
    return null;
  }
}

async function report(cx: Cx, target: Target): Promise<Response> {
  const root = parseXml(await readText(cx.request, MAX_XML_BYTES));
  if (target.t !== 'coll') {
    if (target.t === 'none' || target.t === 'newcoll') throw new DavError(404);
    throw new DavError(403, ['D', 'supported-report']);
  }
  const { coll } = target;
  const u = cx.user;
  const req = parseReportProps(root);
  const wantData = req.mode === 'prop' && req.keys.some(isDataKey);
  const row = (o: ObjectRow) => propResponse(objHref(u, coll, o.uri), objProps(u, coll, o, wantData), req);
  const cal = coll.kind === 'calendar';

  if (root.ns === D && root.name === 'sync-collection') {
    const tokenText = (childOf(root, D, 'sync-token')?.text ?? '').trim();
    const level = (childOf(root, D, 'sync-level')?.text ?? '1').trim();
    if (level !== '1') throw new DavError(403, ['D', 'valid-sync-token']);
    const cols = wantData ? 'o.*' : 'o.id, o.uri, o.etag, o.size, o.component, o.updated_at, o.collection_id';
    let rows: { uri: string; found: ObjectRow | null }[];
    if (!tokenText) {
      rows = (await queryObjects(cx.db, coll.id, { withData: wantData })).map((o) => ({ uri: o.uri, found: o }));
    } else {
      const m = /^urn:cirrus:sync:([0-9A-Z]{26}):(\d{1,15})$/.exec(tokenText);
      // Unknown, foreign or future tokens, and tokens older than the pruned change log, must make the client resync.
      if (!m || m[1] !== coll.id || Number(m[2]) > coll.rev || Number(m[2]) < coll.pruned_rev) throw new DavError(403, ['D', 'valid-sync-token']);
      const { results } = await cx.db.prepare(
        `SELECT c.uri AS c_uri, ${cols} FROM (SELECT DISTINCT uri FROM dav_changes WHERE collection_id = ?1 AND rev > ?2) c
           LEFT JOIN dav_objects o ON o.collection_id = ?1 AND o.uri = c.uri ORDER BY c.uri`,
      ).bind(coll.id, Number(m[2])).all<ObjectRow & { c_uri: string }>();
      rows = results.map((r) => ({ uri: r.c_uri, found: r.id ? r : null }));
    }
    const out = rows.map(({ uri, found }) => found
      ? row(found)
      : `<D:response>${href(objHref(u, coll, uri))}${status('404 Not Found')}</D:response>`);
    return xmlResponse(multistatus(out, `<D:sync-token>${syncToken(coll)}</D:sync-token>`));
  }

  const isMultiget = cal ? root.ns === C && root.name === 'calendar-multiget' : root.ns === CR && root.name === 'addressbook-multiget';
  if (isMultiget) {
    const hrefs = root.children.filter((n) => n.ns === D && n.name === 'href').map((n) => n.text);
    if (hrefs.length > MAX_MULTIGET) throw new DavError(413);
    const prefix = collHref(u, coll);
    const uris = hrefs.map((h) => hrefToUri(h, prefix));
    const found = new Map<string, ObjectRow>();
    const wanted = [...new Set(uris.filter((x): x is string => x !== null))];
    for (let i = 0; i < wanted.length; i += 80) {
      for (const o of await queryObjects(cx.db, coll.id, { withData: wantData, uris: wanted.slice(i, i + 80) })) found.set(o.uri, o);
    }
    return xmlResponse(multistatus(hrefs.map((h, i) => {
      const o = uris[i] === null ? undefined : found.get(uris[i]!);
      return o ? row(o) : `<D:response>${href(h.trim())}${status('404 Not Found')}</D:response>`;
    })));
  }

  if (cal ? root.ns === C && root.name === 'calendar-query' : root.ns === CR && root.name === 'addressbook-query') {
    if (!cal) return xmlResponse(multistatus((await queryObjects(cx.db, coll.id, { withData: wantData })).map(row)));
    const f = filterOf(root);
    if (f.none) return xmlResponse(multistatus([]));
    return xmlResponse(multistatus((await queryObjects(cx.db, coll.id, { ...f, withData: wantData })).map(row)));
  }
  throw new DavError(403, ['D', 'supported-report']);
}

async function put(cx: Cx, target: Target): Promise<Response> {
  if (target.t !== 'obj') throw new DavError(target.t === 'coll' ? 405 : 404);
  const text = await readText(cx.request, MAX_OBJECT_BYTES);
  try {
    const r = await putObject(cx.db, target.coll, target.uri, text, {
      ifMatch: cx.request.headers.get('if-match'), ifNoneMatch: cx.request.headers.get('if-none-match'),
    });
    return new Response(null, { status: r.created ? 201 : 204, headers: { etag: `"${r.etag}"` } });
  } catch (e) {
    if (e instanceof DavError && e.href) e.href = objHref(cx.user, target.coll, e.href);
    throw e;
  }
}

async function get(cx: Cx, target: Target, head: boolean): Promise<Response> {
  if (target.t !== 'obj') throw new DavError(target.t === 'none' || target.t === 'newcoll' ? 404 : 405);
  const o = await getObject(cx.db, target.coll.id, target.uri);
  if (!o) throw new DavError(404);
  return new Response(head ? null : o.data, {
    headers: { 'content-type': contentType(target.coll, o), etag: `"${o.etag}"`, 'last-modified': new Date(o.updated_at).toUTCString() },
  });
}

async function del(cx: Cx, target: Target): Promise<Response> {
  if (target.t === 'obj') {
    await deleteObject(cx.db, target.coll, target.uri, { ifMatch: cx.request.headers.get('if-match') });
    return new Response(null, { status: 204 });
  }
  if (target.t === 'coll') {
    await deleteCollection(cx.db, target.coll);
    return new Response(null, { status: 204 });
  }
  throw new DavError(target.t === 'none' || target.t === 'newcoll' ? 404 : 403);
}

const textOf = (n: XNode | null | undefined) => (n ? n.text.trim() : '');

async function mkcol(cx: Cx, target: Target, method: 'MKCOL' | 'MKCALENDAR'): Promise<Response> {
  if (target.t === 'coll') throw new DavError(405);
  if (target.t !== 'newcoll') throw new DavError(403);
  const body = await readText(cx.request, MAX_XML_BYTES);
  const root = body.trim() ? parseXml(body) : null;
  const prop = root && childOf(childOf(root, D, 'set') ?? ({ children: [] } as unknown as XNode), D, 'prop');
  const get1 = (ns: string, n: string) => prop && childOf(prop, ns, n);
  const types = get1(D, 'resourcetype')?.children.map((n) => n.name) ?? [];
  if (method === 'MKCALENDAR' ? target.kind !== 'calendar' : !types.includes(target.kind)) throw new DavError(403, ['D', 'valid-resourcetype']);
  const comps = (get1(C, 'supported-calendar-component-set')?.children ?? []).map((n) => (n.attrs.name ?? '').toUpperCase()).filter((n) => n === 'VEVENT' || n === 'VTODO');
  const coll = await createCollection(cx.db, cx.user.id, target.kind, target.slug, {
    displayname: textOf(get1(D, 'displayname')).slice(0, 200),
    color: textOf(get1(A, 'calendar-color')).slice(0, 32) || undefined,
    description: textOf(get1(target.kind === 'calendar' ? C : CR, target.kind === 'calendar' ? 'calendar-description' : 'addressbook-description')).slice(0, 2000) || undefined,
    components: comps.join(','),
  });
  return new Response(null, { status: 201, headers: { location: collHref(cx.user, coll) } });
}

async function proppatch(cx: Cx, target: Target): Promise<Response> {
  if (target.t === 'none' || target.t === 'newcoll') throw new DavError(404);
  if (target.t !== 'coll') throw new DavError(403);
  const { coll } = target;
  const root = parseXml(await readText(cx.request, MAX_XML_BYTES));
  if (root.ns !== D || root.name !== 'propertyupdate') throw new XmlError('Expected propertyupdate');
  const patch: { displayname?: string; description?: string | null; color?: string | null } = {};
  const ok: string[] = [], bad: string[] = [];
  const descKey = coll.kind === 'calendar' ? k(C, 'calendar-description') : k(CR, 'addressbook-description');
  for (const op of root.children) {
    if (op.ns !== D || (op.name !== 'set' && op.name !== 'remove')) continue;
    const set = op.name === 'set';
    for (const p of childOf(op, D, 'prop')?.children ?? []) {
      const key = k(p.ns, p.name);
      const v = set ? p.text.trim() : '';
      if (key === k(D, 'displayname') && set && v.length <= 200) { patch.displayname = v; ok.push(key); }
      else if (key === k(A, 'calendar-color') && coll.kind === 'calendar' && v.length <= 32) { patch.color = v || null; ok.push(key); }
      else if (key === descKey && v.length <= 2000) { patch.description = v || null; ok.push(key); }
      else if (key === k(A, 'calendar-order') && coll.kind === 'calendar') ok.push(key);
      else bad.push(key);
    }
  }
  const h = collHref(cx.user, coll);
  if (bad.length) {
    // All or nothing: nothing is applied, the valid properties report 424.
    const body = propstat(bad.map((x) => render(x, '')), '403 Forbidden') + (ok.length ? propstat(ok.map((x) => render(x, '')), '424 Failed Dependency') : '');
    return xmlResponse(multistatus([`<D:response>${href(h)}${body}</D:response>`]));
  }
  await updateCollection(cx.db, coll, patch);
  return xmlResponse(multistatus([`<D:response>${href(h)}${propstat(ok.map((x) => render(x, '')), '200 OK')}</D:response>`]));
}

export const DAV_HEADERS = {
  dav: '1, 3, addressbook, calendar-access',
  allow: ALLOW,
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function finish(res: Response): Response {
  for (const [n, v] of Object.entries(DAV_HEADERS)) res.headers.set(n, v);
  return res;
}

export async function handleDav(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // RFC 6764 service discovery.
  if (url.pathname.startsWith('/.well-known/')) return new Response(null, { status: 301, headers: { location: '/dav/', 'cache-control': 'no-store' } });
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return finish(new Response(null, { status: 200 }));
  const user = await authenticate(request, env);
  if (user instanceof Response) return finish(user);
  const cx: Cx = { env, db: env.DB, user, request };
  try {
    let segs: string[];
    try {
      segs = url.pathname.replace(/^\/dav\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new DavError(400);
    }
    const target = await resolve(cx, segs);
    switch (method) {
      case 'PROPFIND': return finish(await propfind(cx, target));
      case 'REPORT': return finish(await report(cx, target));
      case 'GET': return finish(await get(cx, target, false));
      case 'HEAD': return finish(await get(cx, target, true));
      case 'PUT': return finish(await put(cx, target));
      case 'DELETE': return finish(await del(cx, target));
      case 'MKCOL':
      case 'MKCALENDAR': return finish(await mkcol(cx, target, method));
      case 'PROPPATCH': return finish(await proppatch(cx, target));
      default: return finish(new Response(null, { status: 405 }));
    }
  } catch (e) {
    if (e instanceof DavError) return finish(errorResponse(e));
    if (e instanceof XmlError) return finish(new Response('Invalid XML', { status: 400 }));
    console.error('dav error', (e as Error).name);
    return finish(new Response('Internal error', { status: 500 }));
  }
}
