import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Lock, TriangleAlert } from 'lucide-react';
import type { Attachment, MessageFull } from '@shared/api';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/Spinner';
import type { SigState } from '../../lib/pgp/crypto';
import { extractEncryptedBlock, extractSignedBlock, type PgpDetection } from '../../lib/pgp/detect';
import { lockNow, useUnlocked } from '../../lib/pgp/session';
import { usePgpKey, usePgpKeyring } from '../../lib/queries/pgp';
import { Attachments } from '../mail/Attachments';
import { HtmlBody } from '../mail/HtmlBody';
import { TextBody } from '../mail/TextBody';
import { PgpBadge } from './PgpBadge';
import { UnlockDialog } from './UnlockDialog';

interface View {
  text: string | null;
  html: string | null;
  attachments: Attachment[];
  sig: SigState;
  encrypted: boolean;
}

const none: SigState = { state: 'none' };

/**
 * A message with OpenPGP content. Encrypted ones are decrypted here, in the browser, once the key is unlocked, and
 * the result goes through the normal reader path: HTML is sanitised and shown in the sandboxed iframe (HtmlBody),
 * text goes to TextBody. Signed ones are verified against the sender's key in the keyring (and your own).
 */
export function PgpBody({ message: m, mailboxId, detection }: { message: MessageFull; mailboxId: string; detection: PgpDetection }) {
  const encrypted = detection.kind.startsWith('encrypted');
  const key = usePgpKey();
  const ring = usePgpKeyring();
  const unlocked = useUnlocked();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);

  const own = key.data;
  const sender = ring.data?.find((k) => k.email === m.from.email.toLowerCase());
  const ready = key.isSuccess && ring.isSuccess;
  const canRead = !encrypted || (!!own && unlocked?.fingerprint === own.fingerprint);
  const senderKey = sender?.publicKey;
  const ownKey = own?.publicKey;
  const verifyWith = useMemo(() => [...new Set([senderKey, ownKey].filter((k): k is string => !!k))], [senderKey, ownKey]);

  useEffect(() => {
    if (!ready || !canRead) {
      setView(null);
      return;
    }
    let cancelled = false;
    const urls: string[] = [];
    setError(null);
    (async () => {
      const crypto = await import('../../lib/pgp/crypto');
      const text = m.text ?? '';
      let v: View;
      if (detection.kind === 'encrypted-mime' || detection.kind === 'encrypted-inline') {
        let armored: string | null;
        if (detection.kind === 'encrypted-mime') {
          const res = await fetch(detection.payload!.url, { credentials: 'same-origin' });
          if (!res.ok) throw new Error('The encrypted part could not be loaded.');
          armored = await res.text();
        } else {
          armored = extractEncryptedBlock(text);
        }
        if (!armored) throw new Error('No encrypted data found in this message.');
        const out = await crypto.decryptArmored(armored, unlocked!.key, verifyWith);
        if (detection.kind === 'encrypted-inline') {
          v = { text: new TextDecoder().decode(out.data), html: null, attachments: [], sig: out.signature, encrypted: true };
        } else {
          const { default: PostalMime } = await import('postal-mime');
          const parsed = await PostalMime.parse(out.data, { attachmentEncoding: 'arraybuffer' });
          const attachments = parsed.attachments.map((a, i): Attachment => {
            const bytes = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
            const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: a.mimeType }));
            urls.push(url);
            return { id: `pgp-${i}`, filename: a.filename || 'attachment', mimeType: a.mimeType, size: bytes.byteLength, contentId: null, inline: false, url };
          });
          const hasBody = !!(parsed.text || parsed.html);
          v = { text: hasBody ? (parsed.text ?? null) : new TextDecoder().decode(out.data), html: parsed.html ?? null, attachments, sig: out.signature, encrypted: true };
        }
      } else if (detection.kind === 'signed-inline') {
        const block = extractSignedBlock(text);
        if (!block) throw new Error('No signed text found in this message.');
        const out = await crypto.verifyCleartext(block, verifyWith);
        v = { text: out.text, html: null, attachments: [], sig: out.signature, encrypted: false };
      } else {
        const res = await fetch(`/api/mailboxes/${mailboxId}/messages/${m.id}/raw`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('The original message could not be loaded.');
        const { splitPgpSigned } = await import('../../lib/pgp/mime');
        const parts = splitPgpSigned(new Uint8Array(await res.arrayBuffer()));
        const sig = parts ? await crypto.verifyDetached(parts.signed, parts.signature, verifyWith) : none;
        v = { text: m.text, html: m.html, attachments: [], sig, encrypted: false };
      }
      if (!cancelled) setView(v);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read this message.');
    });
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [ready, canRead, m.id, m.text, m.html, detection.kind, detection.payload, mailboxId, unlocked, verifyWith]);

  if (encrypted && ready && !own) {
    return (
      <Placeholder>
        <p>This message is encrypted, but you have no PGP key yet.</p>
        <Link to="/settings/security" className="mt-2 inline-block text-[13px] font-medium text-selected-fg hover:underline">Set up a key in Settings</Link>
      </Placeholder>
    );
  }
  if (encrypted && ready && !canRead) {
    return (
      <>
        <Placeholder>
          <p>Encrypted message, unlock to read</p>
          <Button size="sm" variant="primary" className="mt-3" onClick={() => setUnlockOpen(true)}>Unlock</Button>
        </Placeholder>
        <UnlockDialog open={unlockOpen} onClose={() => setUnlockOpen(false)} />
      </>
    );
  }
  if (error) {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
        <TriangleAlert size={15} strokeWidth={1.75} className="mt-0.5 shrink-0" />
        <span>{encrypted ? `Couldn't decrypt this message. ${error}` : error}</span>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="flex items-center gap-2 py-6 text-[13px] text-muted"><Spinner size={14} /> {encrypted ? 'Decrypting…' : 'Checking signature…'}</div>
    );
  }
  return (
    <div>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><PgpBadge sig={view.sig} encrypted={view.encrypted} /></div>
        {view.encrypted && (
          <Button size="sm" variant="ghost" icon={<Lock size={13} />} onClick={lockNow}>Lock now</Button>
        )}
      </div>
      {view.html ? <HtmlBody html={view.html} messageId={`${m.id}:pgp`} /> : <TextBody text={view.text ?? ''} />}
      <Attachments items={view.attachments} />
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-md border border-border bg-surface-2 px-4 py-8 text-center text-[13px] text-muted">
      <Lock size={20} strokeWidth={1.75} className="mb-2 text-faint" />
      {children}
    </div>
  );
}
