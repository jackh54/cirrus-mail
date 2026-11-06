// Cirrus Mail service worker: caches the app shell only. Mail (/api/*) is never cached.
const VERSION = 'cirrus-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never touch mail or auth

  // Navigations: network first, fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || Response.error())),
    );
    return;
  }

  // Hashed build assets and fonts are immutable: cache first.
  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok && res.type === 'basic') {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// ---------- Web Push ----------
// Payload (JSON, decrypted by the browser): { type: 'mail' | 'test', mailboxId?, threadId?, title, body, tag }.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const str = (v) => (typeof v === 'string' ? v : '');
  const mb = str(data.mailboxId);
  const thread = str(data.threadId);
  const url = data.type === 'mail' && mb && thread ? `/mail/${encodeURIComponent(mb)}/inbox/${encodeURIComponent(thread)}` : '/';
  // userVisibleOnly: every push must show a notification, so a malformed one still gets a generic one.
  event.waitUntil(
    self.registration.showNotification(str(data.title) || 'Cirrus Mail', {
      body: str(data.body) || 'New mail',
      tag: str(data.tag) || 'cirrus-new-mail',
      renotify: !!str(data.tag), // a new message in a collapsed thread still alerts
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const target = new URL(typeof raw === 'string' ? raw : '/', self.location.origin);
  const url = target.origin === self.location.origin ? target.pathname + target.search : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      const client = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (client) {
        // The app navigates in place (main.tsx); focus first, since focus() needs the click's activation.
        await client.focus();
        client.postMessage({ type: 'cirrus:navigate', url });
        return;
      }
      await self.clients.openWindow(url);
    }),
  );
});
