// Search query parser: `from:x to:x subject:"multi word" has:attachment is:unread is:starred` + free text.
// Structured operators become parameterised SQL on `messages m`; free text becomes a quoted FTS5 MATCH.

export interface Term { value: string; phrase: boolean }

export interface ParsedQuery {
  from: string[];
  to: string[];
  subject: string[];
  hasAttachment: boolean;
  isUnread: boolean;
  isRead: boolean;
  isStarred: boolean;
  text: Term[];
}

export function parseSearch(q: string): ParsedQuery {
  const out: ParsedQuery = { from: [], to: [], subject: [], hasAttachment: false, isUnread: false, isRead: false, isStarred: false, text: [] };
  const re = /(?:([a-zA-Z]+):)?(?:"([^"]*)"?|(\S+))/g;
  let m: RegExpExecArray | null;
  const input = q.slice(0, 500);
  while ((m = re.exec(input))) {
    const key = m[1]?.toLowerCase();
    const quoted = m[2] !== undefined;
    const value = (quoted ? m[2] : m[3] ?? '').trim();
    if (!value && !key) continue;
    switch (key) {
      case 'from': if (value) out.from.push(value); break;
      case 'to': if (value) out.to.push(value); break;
      case 'subject': if (value) out.subject.push(value); break;
      case 'has':
        if (/^attachments?$/i.test(value)) out.hasAttachment = true;
        else if (value) out.text.push({ value: `has:${value}`, phrase: false });
        break;
      case 'is':
        if (/^unread$/i.test(value)) out.isUnread = true;
        else if (/^read$/i.test(value)) out.isRead = true;
        else if (/^starred$/i.test(value)) out.isStarred = true;
        else if (value) out.text.push({ value, phrase: false });
        break;
      default:
        if (key) out.text.push({ value: quoted ? `${key}: ${value}` : `${key}:${value}`, phrase: quoted });
        else if (value) out.text.push({ value, phrase: quoted });
    }
  }
  return out;
}

/** Quotes one FTS5 string, doubling embedded quotes, so user input can never form FTS syntax. */
export function ftsQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Builds the FTS5 MATCH expression for free text. Every term is quoted; the last bare word gets a prefix `*`.
 * Returns null when there is no searchable text.
 */
export function buildFtsQuery(terms: Term[]): string | null {
  const parts: string[] = [];
  terms.forEach((t, i) => {
    // unicode61 drops punctuation anyway; strip control chars and keep the rest literal inside quotes.
    const v = t.value.replace(/[\u0000-\u001f]/g, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(v)) return;
    const last = i === terms.length - 1 && !t.phrase;
    parts.push(ftsQuote(v) + (last ? '*' : ''));
  });
  return parts.length ? parts.join(' ') : null;
}

export function likeEscape(s: string): string {
  return '%' + s.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** SQL conditions over `messages m` (and the FTS subquery). Params are positional `?`; the caller scopes `m.mailbox_id`. */
export function buildSearchSql(p: ParsedQuery): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  for (const f of p.from) {
    where.push("(lower(m.from_email) LIKE ? ESCAPE '\\' OR lower(m.from_name) LIKE ? ESCAPE '\\')");
    params.push(likeEscape(f), likeEscape(f));
  }
  for (const t of p.to) {
    where.push("(lower(m.to_json) LIKE ? ESCAPE '\\' OR lower(m.cc_json) LIKE ? ESCAPE '\\')");
    params.push(likeEscape(t), likeEscape(t));
  }
  for (const s of p.subject) {
    where.push("lower(m.subject) LIKE ? ESCAPE '\\'");
    params.push(likeEscape(s));
  }
  if (p.hasAttachment) where.push('m.has_attachments = 1');
  if (p.isUnread) where.push('m.is_read = 0');
  if (p.isRead) where.push('m.is_read = 1');
  if (p.isStarred) where.push('m.is_starred = 1');
  const fts = buildFtsQuery(p.text);
  if (fts) {
    where.push('m.id IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?)');
    params.push(fts);
  }
  return { where, params };
}
