#!/usr/bin/env node
// Demo only: spreads the seeded messages over the last two weeks so thread lists show a mix of
// times, weekdays and dates instead of the delivery time. Edits the LOCAL D1 only (the same
// .wrangler state the dev server uses) and refuses to run with --remote.
//
//   node scripts/seed-demo-dates.mjs
//
// Idempotent: targets are absolute (days ago + local time of day), matched by direction and subject
// in delivery (id) order, so a second run writes the same values.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.argv.includes('--remote')) {
  console.error('seed-demo-dates only edits the local database; refusing to run with --remote');
  process.exit(1);
}

// [direction, subject, [daysAgo, hour, minute], ...] in delivery order for that subject.
const PLAN = [
  ['in', 'Search index rebuild results', [0, 9, 12]],
  ['in', 'Thank you!', [0, 8, 40]],
  ['in', 'Invitation: Q1 planning workshop', [0, 11, 5]],
  ['in', 'Team lunch Friday?', [1, 16, 20]],
  ['in', 'Re: Custom domain stuck on "checking DNS"', [1, 10, 15]],
  ['in', 'Re: Pilot feedback after week one', [2, 11, 30]],
  ['out', 'Re: Pilot feedback after week one', [2, 15, 45]],
  ['in', 'Urgent: verify your mailbox password within 24 hours', [2, 6, 45]],
  ['in', 'Pricing page copy', [3, 9, 0]],
  ['in', 'Re: Pricing page copy', [3, 13, 25]],
  ['in', 'Feature request: snooze', [4, 14, 5]],
  ['in', 'Offsite venue options', [4, 10, 30]],
  ['out', 'Re: Offsite venue options', [4, 17, 0]],
  ['in', 'Security review checklist before the 0.2 release', [5, 14, 10]],
  ['in', 'Weekly metrics: 1,284 active mailboxes (+6.2%)', [6, 7, 30]],
  ['in', 'Invitation: Design critique, Thu 15:00 to 16:00', [6, 12, 0]],
  ['in', 'Custom domain stuck on "checking DNS"', [6, 16, 35]],
  ['in', '[cirrus/mail] Faster thread list rendering (PR #418)', [7, 9, 50]],
  ['in', 'Pilot feedback after week one', [7, 16, 20]],
  ['in', 'Invoice INV-2026-031 for October illustration work', [8, 15, 5]],
  ['in', 'Standup moved to 10:30 tomorrow', [9, 8, 40]],
  ['in', 'Re: Standup moved to 10:30 tomorrow', [9, 9, 5], [9, 9, 30]],
  ['in', 'The Shipping Log #42: small teams, big releases', [10, 6, 0]],
  ['in', 'Q1 roadmap draft for comment', [11, 10, 15]],
  ['in', 'Re: Onboarding flow v3, ready for review', [12, 9, 20], [12, 14, 0]],
  ['in', 'Onboarding flow v3, ready for review', [13, 11, 40]],
];

const q = (s) => `'${s.replace(/'/g, "''")}'`;
const stamp = ([days, h, m]) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() - days);
  // Never in the future: early in the day, "this morning" falls back to the same time yesterday.
  if (d.getTime() > Date.now() - 10 * 60 * 1000) d.setDate(d.getDate() - 1);
  return d.getTime();
};

const sql = [];
let count = 0;
for (const [dir, subject, ...slots] of PLAN) {
  slots.forEach((slot, i) => {
    const t = stamp(slot);
    count++;
    sql.push(
      `UPDATE messages SET date = ${t}, updated_at = ${t}${dir === 'out' ? `, sent_at = ${t}` : ''} WHERE id = ` +
      `(SELECT id FROM messages WHERE direction = ${q(dir)} AND subject = ${q(subject)} AND status IN ('received', 'sent') ORDER BY id LIMIT 1 OFFSET ${i});`,
    );
  });
}
sql.push('UPDATE threads SET last_message_at = COALESCE((SELECT MAX(date) FROM messages WHERE thread_id = threads.id), last_message_at);');

const dir = mkdtempSync(join(tmpdir(), 'cirrus-dates-'));
try {
  const file = join(dir, 'dates.sql');
  writeFileSync(file, sql.join('\n'));
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--file', file], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Re-dated ${count} demo messages (local D1)`);
