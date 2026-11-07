#!/usr/bin/env node
// Regenerates docs/screenshots/*.png from a seeded local dev server.
//
//   npm run dev                      # in one terminal
//   npm run db:migrate:local && node scripts/seed-demo.mjs   # capture then runs seed-demo-dates.mjs (local D1)
//   node scripts/capture-screenshots.mjs [--url http://localhost:5173] [--chrome /path/to/chrome]
//
// Uses headless Chrome over the DevTools protocol (Node's built-in WebSocket), no extra deps.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.url ?? 'http://localhost:5173';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
const CHROME =
  args.chrome ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(
    (p) => existsSync(p),
  );
if (!CHROME) throw new Error('Chrome not found; pass --chrome <path>');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cirrus': '1' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} (did you run seed-demo.mjs?)`);
  const cookie = res.headers.get('set-cookie')?.match(/cirrus_session=([^;]+)/)?.[1];
  const me = await fetch(`${BASE}/api/me`, { headers: { cookie: `cirrus_session=${cookie}` } }).then((r) => r.json());
  return { cookie, me };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function main() {
  // Demo only: gives the seeded mail realistic dates in the local D1 (never remote).
  execFileSync('node', [new URL('./seed-demo-dates.mjs', import.meta.url).pathname], { stdio: 'inherit' });
  const { cookie, me } = await login('alex@cirrus.test', 'demo-password-123');
  const mb = me.mailboxes.find((m) => m.address === 'alex@cirrus.test') ?? me.mailboxes[0];
  const get = (path) => fetch(`${BASE}${path}`, { headers: { cookie: `cirrus_session=${cookie}` } }).then((r) => r.json());
  const folders = await get(`/api/mailboxes/${mb.id}/folders`);
  const inbox = folders.find((f) => f.role === 'inbox');
  const threads = await get(`/api/mailboxes/${mb.id}/threads?folder=${inbox.id}&limit=50`);
  const byTitle = (s) => threads.items.find((t) => t.subject.includes(s))?.id ?? threads.items[0].id;
  const contacts = await get('/api/dav/contacts?limit=2000');
  const contactId = (contacts.items ?? contacts).find((c) => c.fn === 'Elena Novak')?.id;

  const profile = await mkdtemp(join(tmpdir(), 'cirrus-shot-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9355', `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank',
  ]);
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    await sleep(200);
    wsUrl = await fetch('http://127.0.0.1:9355/json/version').then((r) => r.json()).then((j) => j.webSocketDebuggerUrl).catch(() => null);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const cdp = new Cdp(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  await s('Page.enable');
  await s('Network.enable');
  const host = new URL(BASE).hostname;
  await s('Network.setCookie', { name: 'cirrus_session', value: cookie, domain: host, path: '/', httpOnly: true });

  const evaluate = (expression) => s('Runtime.evaluate', { expression, awaitPromise: true });
  const key = async (k) => {
    await s('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: k });
  };

  async function shot(name, { path, width = 1440, height = 900, scheme = 'light', mobile = false, before }) {
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await s('Page.navigate', { url: BASE + path });
    await sleep(2500);
    if (before) await before();
    const { data } = await s('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`  ${name}.png`);
  }

  await mkdir(OUT, { recursive: true });
  console.log(`Capturing into ${OUT}`);
  await shot('inbox-light', { path: `/mail/${mb.id}/inbox/${byTitle('Invoice INV')}` });
  await shot('inbox-dark', { path: `/mail/${mb.id}/inbox/${byTitle('Security review')}`, scheme: 'dark' });
  await shot('compose', {
    path: `/mail/${mb.id}/inbox/${byTitle('Pricing page')}`,
    scheme: 'dark',
    before: async () => {
      await key('c');
      await sleep(1200);
      await s('Input.insertText', { text: 'hana@cirrus.test' });
      await sleep(900);
      await key('Enter');
      await evaluate(`document.querySelector('input[placeholder="Subject"]')?.focus()`);
      await s('Input.insertText', { text: 'Launch checklist for Thursday' });
      await evaluate(`document.querySelector('.ProseMirror')?.focus()`);
      await s('Input.insertText', {
        text: 'Hi Hana, here is where we landed: copy option A for the hero, pricing table ships as-is, and the docs link moves above the fold. Shout if anything looks off before Thursday.',
      });
      await sleep(800);
    },
  });
  await shot('admin-domains', {
    path: '/admin/domains',
    before: async () => {
      await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Check DNS'))?.click()`);
      await sleep(2500);
    },
  });
  await shot('calendar', { path: '/calendar?v=week' });
  await shot('contacts', { path: `/contacts/${contactId}` });
  await shot('reader-labels', { path: `/mail/${mb.id}/inbox/${byTitle('Pilot feedback')}` });
  await shot('settings-security', {
    path: '/settings/security',
    before: async () => {
      await evaluate(`[...document.querySelectorAll('h2,h3')].find(h => h.textContent.trim() === 'Passkeys')?.scrollIntoView({ block: 'start' })`);
      await sleep(600);
    },
  });
  await shot('invite', { path: `/mail/${mb.id}/inbox/${byTitle('Q1 planning workshop')}` });
  await shot('mobile', { path: `/mail/${mb.id}/inbox`, width: 390, height: 844, mobile: true });

  ws.close();
  chrome.kill();
  await new Promise((r) => chrome.once('exit', r));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
