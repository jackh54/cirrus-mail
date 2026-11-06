// vCard (RFC 6350 / 2426) analysis for storage and the structured contact view used by the JSON API.
import type { ContactField, ContactInput } from '../../shared/api';
import { escapeText, oneLine, parseLines, serialize, unescapeText, type Line } from './lines';

export class VcfError extends Error {}

export interface VcfInfo { uid: string | null; fn: string; emails: string[] }

function load(text: string): Line[] {
  let lines: Line[];
  try {
    lines = parseLines(text);
  } catch {
    throw new VcfError('Malformed content line');
  }
  const first = lines[0], last = lines[lines.length - 1];
  if (!first || !last || first.name !== 'BEGIN' || first.value.trim().toUpperCase() !== 'VCARD' || last.name !== 'END' || last.value.trim().toUpperCase() !== 'VCARD') {
    throw new VcfError('Not a single vCard');
  }
  if (lines.filter((l) => l.name === 'BEGIN').length !== 1 || lines.filter((l) => l.name === 'END').length !== 1) throw new VcfError('Not a single vCard');
  const v = lines.find((l) => l.name === 'VERSION')?.value.trim();
  if (v !== '2.1' && v !== '3.0' && v !== '4.0') throw new VcfError('Unsupported vCard version');
  return lines;
}

const first = (lines: Line[], name: string) => lines.find((l) => l.name === name);

function fields(lines: Line[], name: string): ContactField[] {
  return lines.filter((l) => l.name === name && l.value.trim()).map((l) => ({
    value: unescapeText(l.value.trim()),
    types: (l.params.TYPE ?? '').split(',').map((t) => t.trim().toLowerCase()).filter((t) => t && t !== 'internet'),
  }));
}

function nameFromN(n: string | undefined): string {
  if (!n) return '';
  const [family = '', given = ''] = n.split(';');
  return `${unescapeText(given)} ${unescapeText(family)}`.trim();
}

export function analyzeVcard(text: string): VcfInfo {
  const lines = load(text);
  const emails = fields(lines, 'EMAIL').map((e) => e.value.toLowerCase());
  const fn = unescapeText(first(lines, 'FN')?.value ?? '').trim() || nameFromN(first(lines, 'N')?.value) || emails[0] || '';
  const uid = first(lines, 'UID')?.value.trim() || null;
  if (uid && uid.length > 255) throw new VcfError('UID too long');
  return { uid, fn, emails };
}

export type ContactFields = Omit<ContactInput, 'addressBookId'>;

export function contactFields(text: string): ContactFields {
  const lines = load(text);
  const org = (first(lines, 'ORG')?.value ?? '').split(/(?<!\\);/).map((p) => unescapeText(p).trim()).filter(Boolean).join(' / ');
  return {
    fn: analyzeVcard(text).fn,
    emails: fields(lines, 'EMAIL'),
    phones: fields(lines, 'TEL'),
    org,
    note: unescapeText(first(lines, 'NOTE')?.value ?? ''),
  };
}

const typed = (name: string, f: ContactField): string => {
  const types = f.types.map((t) => t.replace(/[^a-z0-9-]/gi, '')).filter(Boolean);
  return `${name}${types.length ? `;TYPE=${types.join(',')}` : ''}:${escapeText(oneLine(f.value))}`;
};

function nLine(fn: string): string {
  const name = oneLine(fn).trim();
  const sp = name.lastIndexOf(' ');
  const [given, family] = sp < 0 ? ['', name] : [name.slice(0, sp), name.slice(sp + 1)];
  return `N:${escapeText(family)};${escapeText(given)};;;`;
}

export function buildContact(f: ContactFields, uid: string): string {
  return serialize([
    'BEGIN:VCARD', 'VERSION:4.0', `UID:${oneLine(uid)}`, `FN:${escapeText(oneLine(f.fn))}`, nLine(f.fn),
    ...f.emails.map((e) => typed('EMAIL', e)), ...f.phones.map((p) => typed('TEL', p)),
    ...(f.org ? [`ORG:${escapeText(oneLine(f.org))}`] : []), ...(f.note ? [`NOTE:${escapeText(f.note)}`] : []),
    `REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`,
    'END:VCARD',
  ]);
}

/** Applies `f` to `text`, rewriting only the fields that changed. Unknown properties, groups and the vCard version are kept. */
export function applyContact(text: string, f: ContactFields): string {
  const lines = load(text);
  const cur = contactFields(text);
  const remove = new Set<string>();
  const add: string[] = [];
  const set = (names: string[], same: boolean, v: string[]) => { if (!same) { names.forEach((n) => remove.add(n)); add.push(...v); } };
  set(['FN', 'N'], cur.fn === f.fn, [`FN:${escapeText(oneLine(f.fn))}`, nLine(f.fn)]);
  set(['EMAIL'], JSON.stringify(cur.emails) === JSON.stringify(f.emails), f.emails.map((e) => typed('EMAIL', e)));
  set(['TEL'], JSON.stringify(cur.phones) === JSON.stringify(f.phones), f.phones.map((p) => typed('TEL', p)));
  set(['ORG'], cur.org === f.org, f.org ? [`ORG:${escapeText(oneLine(f.org))}`] : []);
  set(['NOTE'], cur.note === f.note, f.note ? [`NOTE:${escapeText(f.note)}`] : []);
  if (!remove.size) return text;
  remove.add('REV');
  add.push(`REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === lines.length - 1) out.push(...add);
    if (!remove.has(l.name) || i === 0) out.push(l.raw);
  });
  return serialize(out);
}
