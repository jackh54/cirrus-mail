// Web Push on this device: support detection (incl. iOS home-screen apps), subscribe / unsubscribe, and the API calls.
import type { PushDevice, PushPublicKeyResponse, PushSubscriptionInput, PushTestResponse } from '@shared/api';
import { api, request } from './api';

export const SW_URL = '/sw.js';

/**
 * - `supported`: Notification, service workers and PushManager are all there.
 * - `ios-install`: iOS/iPadOS Safari outside a home-screen app, where Web Push is unavailable until installed.
 * - `unsupported`: anything else without Web Push.
 */
export type PushSupport = 'supported' | 'ios-install' | 'unsupported';

export function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac; touch points tell them apart.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function pushSupport(): PushSupport {
  if ('serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined') return 'supported';
  // iOS 16.4+ exposes PushManager only to web apps opened from the Home Screen.
  if (!('PushManager' in window) && (navigator as Navigator & { standalone?: boolean }).standalone !== true && isIos()) return 'ios-install';
  return 'unsupported';
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // register() returns the existing registration when there is one; ready waits for it to be active.
  await navigator.serviceWorker.register(SW_URL);
  return navigator.serviceWorker.ready;
}

/** This browser's current push subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export function fetchPublicKey(): Promise<PushPublicKeyResponse> {
  return api.get<PushPublicKeyResponse>('/api/push/public-key');
}

/**
 * Asks for permission (call it straight from a click: Safari requires a user gesture), subscribes with the
 * server's VAPID key and registers the subscription. Returns the permission outcome and the registered device.
 */
export async function enablePush(publicKey?: string): Promise<{ permission: NotificationPermission; device?: PushDevice }> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { permission };
  const key = fromBase64Url(publicKey ?? (await fetchPublicKey()).publicKey);
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different key (e.g. the instance was reinstalled) cannot be reused.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const device = await api.post<PushDevice>('/api/push/subscriptions', sub.toJSON() as PushSubscriptionInput);
  return { permission, device };
}

/** Unsubscribes this browser and removes it on the server. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  // Server first: if that fails, the device stays subscribed and listed, rather than silently orphaned.
  await request<{ ok: boolean }>('/api/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}

const DEVICE_KEY = 'cirrus:pushDevice';

/** The server id of this browser's subscription, remembered so the device list can mark "This device". */
export function getThisDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

export function setThisDeviceId(id: string | null): void {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* ignore */
  }
}

export const pushApi = {
  devices: () => api.get<PushDevice[]>('/api/push/subscriptions'),
  remove: (id: string) => api.del<{ ok: boolean }>(`/api/push/subscriptions/${id}`),
  test: () => api.post<PushTestResponse>('/api/push/test'),
};
