#!/usr/bin/env node
// Deploy guard: fail if the remote D1 database still has unapplied migrations, so new Worker code
// never ships ahead of its schema. A missing database (the very first deploy, before wrangler has
// provisioned it) passes; `npm run deploy` migrates again right after that first deploy.
import { execFileSync } from 'node:child_process';

let out = '';
try {
  out = execFileSync('npx', ['wrangler', 'd1', 'migrations', 'list', 'DB', '--remote'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  if (/database.*(not found|couldn't find)|no such database|database_id/i.test(text)) {
    console.log('check-migrations: D1 not provisioned yet (first deploy); skipping.');
    process.exit(0);
  }
  console.error(text);
  console.error('check-migrations: could not list remote migrations; refusing to deploy.');
  process.exit(1);
}

if (/No migrations to apply/i.test(out)) {
  console.log('check-migrations: remote D1 is up to date.');
  process.exit(0);
}
const pending = [...out.matchAll(/\b(\d{4}_[\w-]+\.sql)\b/g)].map((m) => m[1]);
console.error(`check-migrations: unapplied remote migrations: ${pending.join(', ') || '(unknown)'}`);
console.error('Run `npm run db:migrate:remote` and try again.');
process.exit(1);
