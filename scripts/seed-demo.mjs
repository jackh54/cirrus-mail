#!/usr/bin/env node
// Seeds a running local dev server (npm run dev) with a realistic demo team for screenshots.
//
//   node scripts/seed-demo.mjs [--url http://localhost:5173]
//
// Creates the admin (Alex Rivera, alex@cirrus.test / demo-password-123), the cirrus.test domain,
// alex@ and a shared support@ mailbox, a second user (Sam), ~25 inbound emails over two weeks,
// and a couple of replies sent through the API (local sends are simulated).
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { bareAddress, buildEml, deliver } from './send-test-email.mjs';

const args = process.argv.slice(2);
const URL_BASE = (args[args.indexOf('--url') + 1] && args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5173').replace(/\/$/, '');
const PASSWORD = 'demo-password-123';
const SAM_PASSWORD = 'demo-password-456';

function setupToken() {
  for (const file of ['.dev.vars', '.dev.vars.example']) {
    try {
      const m = readFileSync(file, 'utf8').match(/^SETUP_TOKEN\s*=\s*"?([^"\n]+)"?/m);
      if (m) return m[1].trim();
    } catch { /* try next */ }
  }
  throw new Error('SETUP_TOKEN not found in .dev.vars');
}

// ---------- tiny API client with a cookie jar ----------

function client() {
  const jar = new Map();
  return async function api(method, path, body) {
    const headers = { 'x-cirrus': '1' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(URL_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  };
}

async function must(p, what) {
  const r = await p;
  if (r.status >= 400) throw new Error(`${what} failed (${r.status}): ${JSON.stringify(r.json)}`);
  return r.json;
}

// ---------- fixtures ----------

/** A small solid-colour PNG (iris #4F6BFF), generated so it is always valid. */
function makePng(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng(96, 64, [0x4f, 0x6b, 0xff]);

function pdf(title, lines) {
  const text = [title, ...lines].map((l, i) => `BT /F1 ${i ? 11 : 16} Tf 56 ${760 - i * 22} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const now = Date.now();
const ago = (days, hours = 0) => new Date(now - days * DAY - hours * HOUR);

/** Local wall-clock time `daysFromMonday` days after this week's Monday. */
const monday = new Date(now);
monday.setHours(0, 0, 0, 0);
monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
const at = (daysFromMonday, h, min = 0) => {
  const d = new Date(monday);
  d.setDate(d.getDate() + daysFromMonday);
  d.setHours(h, min, 0, 0);
  return d;
};
const icsStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** A METHOD:REQUEST invitation from Jordan for Thursday next week, 14:00 to 16:00. */
function inviteIcs() {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cirrus Demo//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    'UID:q1-planning-workshop@cirrus.test', `DTSTAMP:${icsStamp(new Date(now))}`, 'SEQUENCE:0',
    `DTSTART:${icsStamp(at(10, 14))}`, `DTEND:${icsStamp(at(10, 16))}`,
    'SUMMARY:Q1 planning workshop', 'LOCATION:Room Atlas',
    'DESCRIPTION:Turn the roadmap draft into a plan.',
    'ORGANIZER;CN=Jordan Lee:mailto:jordan@cirrus.test',
    'ATTENDEE;CN=Alex Rivera;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alex@cirrus.test',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}

const LABELS = [
  { name: 'Clients', color: 'cobalt', subjects: ['Pilot feedback after week one', 'Invoice INV-2026-031 for October illustration work'] },
  { name: 'Receipts', color: 'green', subjects: ['Invoice INV-2026-031 for October illustration work', 'Weekly metrics: 1,284 active mailboxes (+6.2%)'] },
  { name: 'Travel', color: 'amber', subjects: ['Offsite venue options'] },
  { name: 'Follow up', color: 'orange', subjects: ['Pilot feedback after week one', 'Security review checklist before the 0.2 release'] },
];
const SNOOZED_SUBJECT = 'Q1 roadmap draft for comment';

const CONTACTS = [
  { fn: 'Hana Sato', org: 'Cirrus', emails: [{ value: 'hana@cirrus.test', types: ['work'] }], phones: [{ value: '+1 555 0101', types: ['cell'] }], note: 'Design lead.' },
  { fn: 'Dev Patel', org: 'Cirrus', emails: [{ value: 'dev@cirrus.test', types: ['work'] }], phones: [], note: 'Engineering.' },
  { fn: 'Jordan Lee', org: 'Cirrus', emails: [{ value: 'jordan@cirrus.test', types: ['work'] }], phones: [{ value: '+1 555 0103', types: ['work'] }], note: 'Product.' },
  { fn: 'Elena Novak', org: 'Brightpath', emails: [{ value: 'elena@brightpath.test', types: ['work'] }], phones: [{ value: '+1 555 0142', types: ['work'] }], note: 'Pilot customer. Prefers calls on Tuesday afternoons.' },
  { fn: 'Tom Fischer', org: 'Fischer Studio', emails: [{ value: 'tom@fischer-studio.test', types: ['work'] }], phones: [], note: 'Freelance illustrator.' },
  { fn: 'Ravi Menon', org: 'Greenleaf Co-op', emails: [{ value: 'ravi@greenleaf-coop.test', types: ['work'] }], phones: [], note: '' },
  { fn: 'Lucia Romero', org: 'Studio Lumo', emails: [{ value: 'lucia@studio-lumo.test', types: ['work'] }], phones: [], note: '' },
  { fn: 'Grace Kim', org: 'Harbor Books', emails: [{ value: 'grace@harbor-books.test', types: ['work'] }], phones: [{ value: '+1 555 0177', types: ['cell'] }], note: 'Moved the bookshop over in an afternoon.' },
];

const EVENTS = [
  { summary: 'Team sync', start: at(0, 10), end: at(0, 10, 30), location: 'Video call', description: 'Weekly team meeting.', rrule: 'FREQ=WEEKLY;BYDAY=MO' },
  { summary: 'Pilot call: Brightpath', start: at(1, 14), end: at(1, 14, 45), location: 'Video call', description: 'Follow-up with Elena.' },
  { summary: 'Lunch with Tom', start: at(2, 12, 30), end: at(2, 13, 30), location: 'Ramen place on the corner', description: '' },
  { summary: 'Design critique', start: at(3, 15), end: at(3, 16), location: 'Room Atlas', description: 'Onboarding v3, settings IA, dark mode contrast.' },
  { summary: 'Focus time', start: at(4, 9), end: at(4, 11), location: '', description: '' },
];

const ALEX = 'Alex Rivera <alex@cirrus.test>';
const SUPPORT = 'Cirrus Support <support@cirrus.test>';
const PASS_AUTH = (d) => `mx.cloudflare.net; dkim=pass header.d=${d}; spf=pass smtp.mailfrom=${d}; dmarc=pass header.from=${d}`;

/** Each entry: one inbound message. `key` lets later messages reply to earlier ones. */
const MAIL = [
  { key: 'onb1', to: ALEX, from: 'Hana Sato <hana@cirrus.test>', date: ago(13, 3), subject: 'Onboarding flow v3, ready for review',
    text: 'Hi Alex,\n\nThe v3 onboarding flow is up in the design file. Main changes:\n\n- Domain setup moved to step 2, with a live DNS check\n- The "invite your team" step is now skippable\n- New empty states for Inbox and Sent\n\nScreenshot of the new domain step attached. Could you take a look before Thursday\'s critique?\n\nThanks,\nHana',
    attachments: [{ filename: 'onboarding-domain-step.png', type: 'image/png', content: PNG }] },
  { key: 'onb2', to: ALEX, from: 'Dev Patel <dev@cirrus.test>', cc: 'Hana Sato <hana@cirrus.test>', date: ago(12, 20), subject: 'Re: Onboarding flow v3, ready for review', replyTo: 'onb1',
    text: 'Looks great. One concern: the live DNS check can take a few seconds on cold resolvers. Can we show a skeleton state instead of a spinner?\n\nDev\n\n> The v3 onboarding flow is up in the design file.' },
  { key: 'onb3', to: ALEX, from: 'Hana Sato <hana@cirrus.test>', date: ago(12, 17), subject: 'Re: Onboarding flow v3, ready for review', replyTo: 'onb2',
    text: 'Good call, I\'ll swap it for a skeleton row per record (MX, SPF, DMARC). Updated frames by tomorrow.\n\nHana' },
  { key: 'road', to: ALEX, from: 'Jordan Lee <jordan@cirrus.test>', date: ago(11, 6), subject: 'Q1 roadmap draft for comment',
    text: 'Alex,\n\nAttached is the first pass at the Q1 roadmap. The big bets are shared mailboxes v2, faster search, and the mobile compose rewrite. I\'ve left two open questions on page 2.\n\nComments by Friday would be ideal.\n\nJordan',
    attachments: [{ filename: 'q1-roadmap-draft.pdf', type: 'application/pdf', content: pdf('Q1 Roadmap (draft)', ['1. Shared mailboxes v2', '2. Search: sub-100ms on 50k threads', '3. Mobile compose rewrite', 'Open questions: pricing tiers, import tooling']) }] },
  { key: 'news', to: ALEX, from: 'The Shipping Log <hello@shippinglog.test>', date: ago(10, 2), subject: 'The Shipping Log #42: small teams, big releases',
    headers: { 'List-Id': 'The Shipping Log <weekly.shippinglog.test>', 'List-Unsubscribe': '<https://shippinglog.test/unsubscribe>', Precedence: 'bulk' },
    html: `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#1f2937">
<img src="https://placehold.co/600x180/4F6BFF/FFFFFF/png?text=The+Shipping+Log" alt="The Shipping Log" width="600" style="display:block;width:100%;border-radius:8px">
<h1 style="font-size:26px;margin:24px 0 8px">Small teams, big releases</h1>
<p style="font-size:16px;line-height:1.6">This week: how a four-person team ships weekly without a release manager, a field guide to feature flags that don't rot, and three changelogs worth stealing from.</p>
<h2 style="font-size:18px;margin-top:28px">1. The Friday freeze is a myth</h2>
<p style="font-size:15px;line-height:1.6">Shipping on Fridays is fine when rollbacks take thirty seconds. The trick is making the undo path boring.</p>
<h2 style="font-size:18px;margin-top:28px">2. Flags with an expiry date</h2>
<p style="font-size:15px;line-height:1.6">Every flag gets an owner and a removal date at creation. A weekly bot posts the overdue ones.</p>
<p style="margin-top:32px"><a href="https://shippinglog.test/42" style="background:#4F6BFF;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Read the full issue</a></p>
<p style="font-size:12px;color:#6b7280;margin-top:40px">You are receiving this because you subscribed at shippinglog.test. <a href="https://shippinglog.test/unsubscribe">Unsubscribe</a></p></div>` },
  { key: 'stand1', to: ALEX, from: 'Marco Bellini <marco@cirrus.test>', cc: 'team@cirrus.test', date: ago(9, 9), subject: 'Standup moved to 10:30 tomorrow',
    text: 'Morning all,\n\nI have a dentist appointment, so tomorrow\'s standup moves to 10:30. Same link.\n\nMarco' },
  { key: 'stand2', to: ALEX, from: 'Priya Natarajan <priya@cirrus.test>', cc: 'team@cirrus.test', date: ago(9, 8), subject: 'Re: Standup moved to 10:30 tomorrow', replyTo: 'stand1',
    text: 'Works for me. Can we keep it to 15 minutes? I\'m pairing with Dev on the search index at 11.\n\nPriya' },
  { key: 'stand3', to: ALEX, from: 'Marco Bellini <marco@cirrus.test>', cc: 'team@cirrus.test', date: ago(9, 7), subject: 'Re: Standup moved to 10:30 tomorrow', replyTo: 'stand2',
    text: 'Deal. 15 minutes, hard stop.' },
  { key: 'invoice', to: ALEX, from: 'Tom Fischer <tom@fischer-studio.test>', date: ago(8, 4), subject: 'Invoice INV-2026-031 for October illustration work',
    headers: { 'Authentication-Results': PASS_AUTH('fischer-studio.test') },
    text: 'Hi Alex,\n\nPlease find attached the invoice for the October illustration work (empty states, 404 page and the marketing hero). Payment terms are 30 days as usual.\n\nThanks again, it was a fun project.\n\nTom Fischer\nFischer Studio',
    attachments: [{ filename: 'INV-2026-031.pdf', type: 'application/pdf', content: pdf('Invoice INV-2026-031', ['Fischer Studio', 'Empty state illustrations x6', '404 page illustration', 'Marketing hero', 'Total due: 2,450.00 EUR']) }] },
  { key: 'pilot1', to: ALEX, from: 'Elena Novak <elena@brightpath.test>', date: ago(7, 22), subject: 'Pilot feedback after week one',
    headers: { 'Authentication-Results': PASS_AUTH('brightpath.test') },
    text: 'Hi Alex,\n\nWe\'re a week into the pilot with our 12-person team. Quick summary:\n\n+ Setup took under 20 minutes, including DNS\n+ Search is noticeably faster than what we had\n- Two people missed the keyboard shortcut sheet entirely\n- We\'d love a way to share one mailbox for invoices@\n\nHappy to jump on a call next week.\n\nElena Novak\nOperations, Brightpath' },
  { key: 'pr', to: ALEX, from: 'CodeHost <notifications@codehost.test>', date: ago(7, 5), subject: '[cirrus/mail] Faster thread list rendering (PR #418)',
    headers: { 'List-Id': 'cirrus/mail <mail.cirrus.codehost.test>', 'Auto-Submitted': 'auto-generated' },
    text: 'Dev Patel requested your review on #418.\n\nVirtualizes the thread list and memoizes row rendering. Scrolling 10k threads now holds 60fps on a mid-range phone.\n\n4 files changed, +212 -87\n\nView it on CodeHost: https://codehost.test/cirrus/mail/pull/418' },
  { key: 'crit', to: ALEX, from: 'Hana Sato <hana@cirrus.test>', date: ago(6, 10), subject: 'Invitation: Design critique, Thu 15:00 to 16:00',
    text: 'Design critique\nThursday, 15:00 to 16:00\nRoom: Atlas (or the usual video link)\n\nAgenda:\n1. Onboarding v3 (Hana)\n2. Settings information architecture (Priya)\n3. Dark mode contrast pass (Marco)\n\nPlease add anything else to the doc beforehand.' },
  { key: 'metrics', to: ALEX, from: 'Cirrus Metrics <metrics@cirrus.test>', date: ago(6, 1), subject: 'Weekly metrics: 1,284 active mailboxes (+6.2%)',
    headers: { 'Auto-Submitted': 'auto-generated' },
    html: `<table style="font-family:Inter,Arial,sans-serif;border-collapse:collapse;min-width:420px">
<tr><td colspan="2" style="font-size:18px;font-weight:600;padding:8px 0">Weekly metrics</td></tr>
<tr><td style="padding:6px 16px 6px 0;color:#6b7280">Active mailboxes</td><td style="font-weight:600">1,284 <span style="color:#16a34a">+6.2%</span></td></tr>
<tr><td style="padding:6px 16px 6px 0;color:#6b7280">Messages received</td><td style="font-weight:600">48,910</td></tr>
<tr><td style="padding:6px 16px 6px 0;color:#6b7280">Messages sent</td><td style="font-weight:600">9,377</td></tr>
<tr><td style="padding:6px 16px 6px 0;color:#6b7280">Median search latency</td><td style="font-weight:600">38 ms</td></tr>
</table>` },
  { key: 'sec', to: ALEX, from: 'Dev Patel <dev@cirrus.test>', date: ago(5, 8), subject: 'Security review checklist before the 0.2 release',
    text: 'Alex,\n\nHere\'s the checklist I\'d like us to sign off before tagging 0.2:\n\n1. Session cookie flags verified in production\n2. CSRF header enforced on every write route\n3. Image proxy SSRF tests green\n4. Signed attachment URLs expire after an hour\n5. Rate limiting on login confirmed\n\nI\'ve done 1 to 3. Could you own 4 and 5?\n\nDev' },
  { key: 'offsite', to: ALEX, from: 'Priya Natarajan <priya@cirrus.test>', date: ago(4, 12), subject: 'Offsite venue options',
    text: 'Hi Alex,\n\nThree options for the spring offsite (all within budget):\n\n1. Lakehouse, 2 nights, sleeps 10, 1h by train\n2. Converted barn, 2 nights, great workshop space, needs a car\n3. City co-working loft + hotel, easiest travel, least "offsite" feel\n\nI lean towards option 1. Thoughts?\n\nPriya' },
  { key: 'copy1', to: ALEX, from: 'Hana Sato <hana@cirrus.test>', date: ago(3, 15), subject: 'Pricing page copy',
    text: 'Draft headline options for the pricing page:\n\nA) "Your domain. Your mail. Your Cloudflare account."\nB) "Email you actually own."\nC) "Run your team\'s email for the price of a coffee."\n\nI like A for clarity. Which way are you leaning?' },
  { key: 'copy2', to: ALEX, from: 'Jordan Lee <jordan@cirrus.test>', cc: 'Hana Sato <hana@cirrus.test>', date: ago(3, 12), subject: 'Re: Pricing page copy', replyTo: 'copy1',
    text: 'A is clearest. B is punchier but might read as a dig at other providers. +1 for A with B as the sub-headline.' },
  { key: 'pilot2', to: ALEX, from: 'Elena Novak <elena@brightpath.test>', date: ago(2, 20), subject: 'Re: Pilot feedback after week one', replyTo: 'pilot1',
    headers: { 'Authentication-Results': PASS_AUTH('brightpath.test') },
    text: 'One more thing: the vacation responder worked perfectly while I was out. Our finance lead asked whether we can export a mailbox as .eml files. Is that on the roadmap?\n\nElena' },
  { key: 'phish', to: ALEX, from: 'Mailbox Security <security@cirrus-support.test>', date: ago(2, 6), subject: 'Urgent: verify your mailbox password within 24 hours',
    headers: { 'Authentication-Results': 'mx.cloudflare.net; dkim=fail header.d=cirrus-support.test; spf=fail smtp.mailfrom=cirrus-support.test; dmarc=fail header.from=cirrus-support.test' },
    html: '<p>Dear user,</p><p>Your mailbox storage is almost full. <a href="https://cirrus-support.test/verify">Verify your password</a> within 24 hours to avoid losing messages.</p><p>Security Team</p>' },
  { key: 'lunch', to: ALEX, from: 'Marco Bellini <marco@cirrus.test>', date: ago(1, 9), subject: 'Team lunch Friday?',
    text: 'The new ramen place on the corner opened this week. Friday 12:30? I\'ll book a table for 6 if enough people are in.' },
  { key: 'search', to: ALEX, from: 'Priya Natarajan <priya@cirrus.test>', date: ago(0, 5), subject: 'Search index rebuild results',
    text: 'Rebuilt the FTS index on the staging dataset (52k messages):\n\n- Index size: 61 MB\n- p50 query: 21 ms, p95: 74 ms\n- Prefix queries on the last term work as expected\n\nShipping the migration behind a flag tomorrow unless anyone objects.' },
  { key: 'invite', to: ALEX, from: 'Jordan Lee <jordan@cirrus.test>', date: ago(0, 3), subject: 'Invitation: Q1 planning workshop',
    text: 'Hi Alex,\n\nI\'d like to block two hours to turn the roadmap draft into a plan. Invitation attached.\n\nJordan',
    attachments: [{ filename: 'invite.ics', type: 'text/calendar; method=REQUEST', content: Buffer.from(inviteIcs(), 'utf8') }] },
  { key: 'sup1', to: SUPPORT, from: 'Ravi Menon <ravi@greenleaf-coop.test>', date: ago(6, 3), subject: 'Custom domain stuck on "checking DNS"',
    headers: { 'Authentication-Results': PASS_AUTH('greenleaf-coop.test') },
    text: 'Hello,\n\nI added our domain yesterday and the admin page still shows MX as not OK. Our DNS host says the records are there. What should I check?\n\nThanks,\nRavi' },
  { key: 'sup2', to: SUPPORT, from: 'Lucia Romero <lucia@studio-lumo.test>', date: ago(4, 2), subject: 'Feature request: snooze',
    text: 'Hi team,\n\nLoving Cirrus so far. The one thing I miss from my old client is snooze: hide a thread until Monday 9am and bring it back to the top of the inbox. Any plans?\n\nLucia' },
  { key: 'sup3', to: SUPPORT, from: 'Ravi Menon <ravi@greenleaf-coop.test>', date: ago(1, 4), subject: 'Re: Custom domain stuck on "checking DNS"', replyTo: 'sup1',
    text: 'Update: it was an old MX record at a lower priority. Removed it and everything is green now. Thanks for the pointer!\n\nRavi' },
  { key: 'sup4', to: SUPPORT, from: 'Grace Kim <grace@harbor-books.test>', date: ago(0, 2), subject: 'Thank you!',
    text: 'Just wanted to say thanks. We moved our bookshop\'s email over in an afternoon and haven\'t looked back.\n\nGrace\nHarbor Books' },
];

// ---------- run ----------

async function main() {
  console.log(`Seeding ${URL_BASE}`);
  const alex = client();
  const status = await must(alex('GET', '/api/setup/status'), 'setup status');
  if (status.needsSetup) {
    await must(alex('POST', '/api/setup', { token: setupToken(), name: 'Alex Rivera', email: 'alex@cirrus.test', password: PASSWORD }), 'setup');
    console.log('  created admin alex@cirrus.test');
  } else {
    await must(alex('POST', '/api/auth/login', { email: 'alex@cirrus.test', password: PASSWORD }), 'login (instance already set up)');
    console.log('  instance already set up; signed in as alex@cirrus.test');
  }
  const me = await must(alex('GET', '/api/me'), 'me');

  let domains = await must(alex('GET', '/api/admin/domains'), 'list domains');
  let domain = domains.find((d) => d.name === 'cirrus.test');
  if (!domain) domain = await must(alex('POST', '/api/admin/domains', { name: 'cirrus.test' }), 'create domain');

  const users = await must(alex('GET', '/api/admin/users'), 'list users');
  let sam = users.find((u) => u.email === 'sam@cirrus.test');
  if (!sam) sam = await must(alex('POST', '/api/admin/users', { name: 'Sam Okafor', email: 'sam@cirrus.test', role: 'member', tempPassword: SAM_PASSWORD, mailbox: { localPart: 'sam', domainId: domain.id } }), 'create Sam');

  const boxes = await must(alex('GET', '/api/admin/mailboxes'), 'list mailboxes');
  let alexBox = boxes.find((b) => b.address === 'alex@cirrus.test');
  if (!alexBox) alexBox = await must(alex('POST', '/api/admin/mailboxes', { localPart: 'alex', domainId: domain.id, displayName: 'Alex Rivera', members: [{ userId: me.user.id, role: 'owner' }] }), 'create alex@');
  let supportBox = boxes.find((b) => b.address === 'support@cirrus.test');
  if (!supportBox) supportBox = await must(alex('POST', '/api/admin/mailboxes', { localPart: 'support', domainId: domain.id, displayName: 'Cirrus Support', members: [{ userId: me.user.id, role: 'owner' }, { userId: sam.id, role: 'member' }] }), 'create support@');
  console.log('  domain cirrus.test, mailboxes alex@ and support@ (shared with Sam)');

  const ids = {};
  let delivered = 0;
  for (const m of MAIL) {
    const parent = m.replyTo ? ids[m.replyTo] : undefined;
    const { raw, messageId } = buildEml({
      from: m.from, to: m.to, cc: m.cc, subject: m.subject, text: m.text, html: m.html, date: m.date,
      inReplyTo: parent?.id, references: parent ? [parent.refs, parent.id].filter(Boolean).join(' ') : undefined,
      headers: m.headers, attachments: m.attachments,
    });
    ids[m.key] = { id: messageId, refs: parent ? [parent.refs, parent.id].filter(Boolean).join(' ') : '' };
    const out = await deliver(URL_BASE, bareAddress(m.from), bareAddress(m.to), raw);
    if (out && typeof out === 'object' && out.outcome && out.outcome !== 'ok') console.warn(`  ! ${m.subject}: ${out.outcome} ${out.rejectReason ?? ''}`);
    delivered++;
  }
  console.log(`  delivered ${delivered} inbound emails`);

  // Replies from Alex through the API so Sent has content (local sends are simulated).
  const replies = [
    { subject: 'Pilot feedback after week one', html: '<p>Hi Elena,</p><p>Thanks, this is really useful. Shared mailboxes are live now: an admin can add <b>invoices@</b> and give your finance team access. Mailbox export is on the Q1 roadmap.</p><p>How does Tuesday 14:00 look for a call?</p><p>Alex</p>' },
    { subject: 'Offsite venue options', html: '<p>Option 1 gets my vote too. Let\'s check dates with everyone at standup.</p><p>Alex</p>' },
  ];
  const threads = await must(alex('GET', `/api/mailboxes/${alexBox.id}/threads?limit=100`), 'list threads');
  for (const r of replies) {
    const t = threads.items.find((x) => x.subject === r.subject);
    if (!t) continue;
    const detail = await must(alex('GET', `/api/mailboxes/${alexBox.id}/threads/${t.id}`), 'thread');
    const last = [...detail.messages].reverse().find((m) => m.direction === 'in');
    const draft = await must(alex('POST', `/api/mailboxes/${alexBox.id}/drafts`, {
      from: 'alex@cirrus.test', to: [last.from], cc: [], bcc: [], subject: `Re: ${r.subject}`, html: r.html, parentId: last.id, composeMode: 'reply',
    }), 'create reply');
    const sent = await alex('POST', `/api/mailboxes/${alexBox.id}/drafts/${draft.id}/send`, {});
    if (sent.status >= 400) console.warn(`  ! send "${r.subject}" failed: ${JSON.stringify(sent.json)}`);
  }
  console.log('  sent 2 replies');

  // Labels, one snoozed thread, contacts, calendar events and app passwords, all through the public API.
  const inboxThreads = await must(alex('GET', `/api/mailboxes/${alexBox.id}/threads?limit=100`), 'list threads');
  const threadId = (subject) => inboxThreads.items.find((x) => x.subject === subject)?.id;
  const existing = await must(alex('GET', `/api/mailboxes/${alexBox.id}/labels`), 'list labels');
  for (const l of LABELS) {
    const label = existing.find((x) => x.name === l.name) ?? await must(alex('POST', `/api/mailboxes/${alexBox.id}/labels`, { name: l.name, color: l.color }), `create label ${l.name}`);
    const threadIds = l.subjects.map(threadId).filter(Boolean);
    if (threadIds.length) await must(alex('POST', `/api/mailboxes/${alexBox.id}/threads/labels`, { threadIds, add: [label.id] }), `apply label ${l.name}`);
  }
  const snoozed = threadId(SNOOZED_SUBJECT);
  if (snoozed) await must(alex('POST', `/api/mailboxes/${alexBox.id}/threads/actions`, { threadIds: [snoozed], action: 'snooze', until: at(7, 9).getTime() }), 'snooze');
  console.log('  labels (Clients, Receipts, Travel, Follow up) and one snoozed thread');

  const haveContacts = await must(alex('GET', '/api/dav/contacts?limit=2000'), 'list contacts');
  for (const c of CONTACTS.filter((c) => !(haveContacts.items ?? haveContacts).some((x) => x.fn === c.fn))) await must(alex('POST', '/api/dav/contacts', c), `create contact ${c.fn}`);
  const from = new Date(monday); from.setDate(from.getDate() - 14);
  const to = new Date(monday); to.setDate(to.getDate() + 28);
  const haveEvents = await must(alex('GET', `/api/dav/events?from=${from.toISOString()}&to=${to.toISOString()}`), 'list events');
  for (const e of EVENTS.filter((e) => !(haveEvents.items ?? haveEvents).some((x) => x.summary === e.summary))) {
    await must(alex('POST', '/api/dav/events', { ...e, start: e.start.toISOString(), end: e.end.toISOString(), allDay: false }), `create event ${e.summary}`);
  }
  console.log(`  ${CONTACTS.length} contacts and ${EVENTS.length} events this week`);

  const haveApps = await must(alex('GET', '/api/app-passwords'), 'list app passwords');
  for (const name of ['Thunderbird on laptop', 'iPhone Mail'].filter((n) => !haveApps.some((x) => x.name === n))) {
    await must(alex('POST', '/api/app-passwords', { name, password: PASSWORD }), `create app password ${name}`);
  }
  console.log('  2 app passwords');
  console.log(`\nDone. Sign in at ${URL_BASE} as alex@cirrus.test / ${PASSWORD} (Sam: sam@cirrus.test / ${SAM_PASSWORD}).`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
