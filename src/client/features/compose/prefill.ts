import type { Address, Identity, MailboxSummary, MessageFull } from '@shared/api';
import { escapeHtml, formatAddress, longDate } from '../../lib/format';
import { sanitizeBasic, sanitizeForQuote } from '../../lib/sanitize';
import { identitiesOf } from './identities';
import type { ComposeDraft } from './types';

export { identitiesOf };

function newKey(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function signatureBlock(sig: string): string {
  return sig.trim() ? `<p></p>${sanitizeBasic(sig)}` : '';
}

function bodyOf(m: MessageFull): string {
  if (m.html) return sanitizeForQuote(m.html);
  return textToHtml(m.text ?? '');
}

function prefixSubject(prefix: 'Re' | 'Fwd', subject: string): string {
  const re = prefix === 'Re' ? /^\s*(re|aw|sv)\s*:/i : /^\s*(fwd?|wg)\s*:/i;
  return re.test(subject) ? subject : `${prefix}: ${subject}`;
}

function dedupe(list: Address[], exclude: Set<string>): Address[] {
  const seen = new Set(exclude);
  const out: Address[] = [];
  for (const a of list) {
    const k = a.email.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

function pickFrom(ids: Identity[], parent?: MessageFull): string {
  if (parent) {
    const addressed = [...parent.to, ...parent.cc, ...parent.bcc, parent.from].map((a) => a.email.toLowerCase());
    const hit = ids.find((i) => addressed.includes(i.email.toLowerCase()));
    if (hit) return hit.email;
  }
  return (ids.find((i) => !i.isAlias) ?? ids[0]).email;
}

function base(mb: MailboxSummary): ComposeDraft {
  return {
    key: newKey(), mailboxId: mb.id, draftId: null, from: pickFrom(identitiesOf(mb)),
    to: [], cc: [], bcc: [], subject: '', html: '', parentId: null, composeMode: 'new', attachments: [],
  };
}

export function buildNew(mb: MailboxSummary, signature: string, to: Address[] = []): ComposeDraft {
  return { ...base(mb), to, html: signature.trim() ? `<p></p>${signatureBlock(signature)}` : '' };
}

export function buildReply(mb: MailboxSummary, signature: string, parent: MessageFull, mode: 'reply' | 'reply_all' | 'forward'): ComposeDraft {
  const ids = identitiesOf(mb);
  const mine = new Set(ids.map((i) => i.email.toLowerCase()));
  const d: ComposeDraft = { ...base(mb), from: pickFrom(ids, parent), parentId: parent.id, composeMode: mode };

  if (mode === 'forward') {
    const header =
      '<p>---------- Forwarded message ---------<br>' +
      `From: ${escapeHtml(formatAddress(parent.from))}<br>` +
      `Date: ${escapeHtml(longDate(parent.date))}<br>` +
      `Subject: ${escapeHtml(parent.subject)}<br>` +
      `To: ${escapeHtml(parent.to.map(formatAddress).join(', '))}</p>`;
    return { ...d, subject: prefixSubject('Fwd', parent.subject), html: `<p></p>${signatureBlock(signature)}${header}${bodyOf(parent)}` };
  }

  const outgoing = parent.direction === 'out';
  const primary: Address[] = outgoing
    ? parent.to
    : [parent.replyTo ? { email: parent.replyTo } : parent.from];
  const to = mode === 'reply_all' ? dedupe([...primary, ...parent.to], mine) : dedupe(primary, outgoing ? new Set() : mine);
  const cc = mode === 'reply_all' ? dedupe(parent.cc, new Set([...mine, ...to.map((a) => a.email.toLowerCase())])) : [];
  const who = escapeHtml(formatAddress(parent.from));
  const quote = `<p>On ${escapeHtml(longDate(parent.date))}, ${who} wrote:</p><blockquote>${bodyOf(parent)}</blockquote>`;
  return {
    ...d,
    to: to.length ? to : primary,
    cc,
    subject: prefixSubject('Re', parent.subject),
    html: `<p></p>${signatureBlock(signature)}${quote}`,
  };
}

export function fromExistingDraft(m: MessageFull, mailboxId: string): ComposeDraft {
  return {
    key: newKey(),
    mailboxId,
    draftId: m.id,
    from: m.from.email,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    html: m.html ? sanitizeBasic(m.html) : textToHtml(m.text ?? ''),
    parentId: m.parentId,
    composeMode: m.composeMode ?? 'new',
    attachments: m.attachments.filter((a) => !a.inline),
  };
}
