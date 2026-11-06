// Thin browser side of WebAuthn: converts the server's JSON options to ArrayBuffers and the result back to JSON.
import type { PasskeyAssertionJSON, PasskeyAttestationJSON } from '@shared/api';

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

export async function conditionalUiSupported(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    return (await PublicKeyCredential.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

function fromB64u(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function toB64u(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** True when the person dismissed the browser prompt (or it timed out); not an error worth showing. */
export function isPasskeyCancel(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
}

export async function createPasskey(options: Json): Promise<PasskeyAttestationJSON> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...options,
    challenge: fromB64u(options.challenge),
    user: { ...options.user, id: fromB64u(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c: Json) => ({ ...c, id: fromB64u(c.id) })),
  } as PublicKeyCredentialCreationOptions;
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No credential', 'NotAllowedError');
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: 'public-key',
    response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: r.getTransports?.() ?? [] },
  };
}

export async function getPasskey(options: Json, opts: { conditional?: boolean; signal?: AbortSignal } = {}): Promise<PasskeyAssertionJSON> {
  const publicKey = { ...options, challenge: fromB64u(options.challenge) } as PublicKeyCredentialRequestOptions;
  const cred = (await navigator.credentials.get({
    publicKey, signal: opts.signal, ...(opts.conditional ? { mediation: 'conditional' as CredentialMediationRequirement } : {}),
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No credential', 'NotAllowedError');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: 'public-key',
    response: {
      clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature),
      userHandle: r.userHandle ? toB64u(r.userHandle) : null,
    },
  };
}
