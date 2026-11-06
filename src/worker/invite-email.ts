// The invite email: who invited you, a one-time link to set a password. No tracking, no remote images.
import type { AdminInviteResponse } from '../shared/api';
import { escapeHtml } from './lib/html';
import { cleanHeaderText } from './lib/validate';
import { domainOf } from './lib/addresses';
import { mapSendError } from './outbound/send';

export interface InviteEmailInput {
  adminId: string;
  adminName: string;
  to: string;                  // the invitee's sign-in email
  name: string;                // the invitee's name
  mailboxAddresses: string[];  // every mailbox they belong to (a new one and any shared ones)
  url: string;
  expiresAt: number;
  send: boolean;
}

/** The inviting admin's first mailbox (owned ones first), else noreply@ on the invited mailbox's domain, else the first domain. */
async function pickSender(env: Env, adminId: string, mailboxAddress: string | undefined): Promise<string | null> {
  const own = await env.DB.prepare(
    `SELECT m.address FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id
      WHERE mm.user_id = ? ORDER BY (mm.role = 'owner') DESC, m.address LIMIT 1`,
  ).bind(adminId).first<string>('address');
  if (own) return own;
  const domain = mailboxAddress
    ? domainOf(mailboxAddress)
    : await env.DB.prepare('SELECT name FROM domains ORDER BY created_at, name LIMIT 1').first<string>('name');
  return domain ? `noreply@${domain}` : null;
}

/** Every mailbox address the user belongs to, sorted. */
export async function memberAddresses(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db.prepare(
    'SELECT m.address FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id WHERE mm.user_id = ? ORDER BY m.address',
  ).bind(userId).all<{ address: string }>();
  return results.map((r) => r.address);
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
}

export function renderInvite(appName: string, i: InviteEmailInput): { subject: string; html: string; text: string } {
  const inviter = cleanHeaderText(i.adminName).trim() || 'An admin';
  const subject = `${inviter} invited you to ${appName}`;
  const expires = formatDate(i.expiresAt);
  const e = escapeHtml;
  const facts: [string, string][] = [];
  if (i.mailboxAddresses.length) facts.push([i.mailboxAddresses.length > 1 ? 'Your addresses' : 'Your address', i.mailboxAddresses.join(', ')]);
  facts.push(['Sign-in email', i.to]);

  const factRows = facts.map(([k, v]) =>
    `<tr><td style="padding:2px 0;font-size:14px;color:#6b7280;">${e(k)}</td></tr><tr><td style="padding:0 0 10px;font-size:15px;color:#111827;">${e(v)}</td></tr>`).join('');
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td style="padding:32px 28px 8px;font-size:20px;font-weight:600;color:#111827;">${e(inviter)} invited you to ${e(appName)}</td></tr>
<tr><td style="padding:8px 28px 16px;font-size:15px;line-height:22px;color:#374151;">Hi ${e(i.name)}, an account has been set up for you.</td></tr>
<tr><td style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${factRows}</table></td></tr>
<tr><td style="padding:8px 28px 16px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#2B63E8;border-radius:8px;"><a href="${e(i.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Set up your account</a></td></tr></table></td></tr>
<tr><td style="padding:0 28px 8px;font-size:13px;line-height:20px;color:#6b7280;">Or paste this link into your browser:<br><span style="word-break:break-all;color:#374151;">${e(i.url)}</span></td></tr>
<tr><td style="padding:8px 28px 4px;font-size:13px;line-height:20px;color:#6b7280;">This link expires on ${e(expires)}.</td></tr>
<tr><td style="padding:0 28px 28px;font-size:13px;line-height:20px;color:#6b7280;">If you weren't expecting this, you can ignore it.</td></tr>
</table></td></tr></table>
</body></html>`;
  const text = [
    `${inviter} invited you to ${appName}`,
    '',
    `Hi ${i.name}, an account has been set up for you.`,
    '',
    ...(i.mailboxAddresses.length ? [`${i.mailboxAddresses.length > 1 ? 'Your addresses' : 'Your address'}: ${i.mailboxAddresses.join(', ')}`] : []),
    `Sign-in email: ${i.to}`,
    '',
    'Set up your account:',
    i.url,
    '',
    `This link expires on ${expires}.`,
    "If you weren't expecting this, you can ignore it.",
  ].join('\n');
  return { subject, html, text };
}

export async function sendInviteEmail(env: Env, i: InviteEmailInput): Promise<AdminInviteResponse['email']> {
  if (!i.send) return { sent: false, reason: 'NOT_REQUESTED' };
  const host = domainOf(i.to);
  if (await env.DB.prepare('SELECT 1 FROM domains WHERE name = ? COLLATE NOCASE').bind(host).first()) return { sent: false, reason: 'HOSTED_HERE' };
  const address = await pickSender(env, i.adminId, i.mailboxAddresses[0]);
  if (!address) return { sent: false, reason: 'NO_SENDING_DOMAIN' };
  const appName = cleanHeaderText(env.APP_NAME || 'Cirrus Mail').trim();
  const fromName = cleanHeaderText(`${i.adminName} via ${appName}`).trim().slice(0, 120);
  const { subject, html, text } = renderInvite(appName, i);
  try {
    await env.EMAIL.send({ from: { email: address, name: fromName }, to: i.to, subject: cleanHeaderText(subject).slice(0, 200), html, text });
    return { sent: true, from: address };
  } catch (err) {
    const { code, message } = mapSendError(err);
    console.error('invite email failed', code);
    return { sent: false, reason: 'SEND_FAILED', error: message };
  }
}
