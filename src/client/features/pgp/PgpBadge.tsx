import { KeyRound, Lock, PenLine, TriangleAlert } from 'lucide-react';
import type { SigState } from '../../lib/pgp/crypto';
import { cn } from '../../lib/cn';
import { Tooltip } from '../../components/Tooltip';

/** `E109 DE03 20D9 6DB4 ...` for display. */
export function groupFingerprint(fp: string): string {
  return fp.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

const short = (fp: string) => fp.slice(-16);

function Chip({ tone, icon, children, tip, label }: { tone: 'ok' | 'bad' | 'muted'; icon: React.ReactNode; children: React.ReactNode; tip: React.ReactNode; label: string }) {
  return (
    <Tooltip label={label} content={tip}>
      <span
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[12px] leading-4 font-medium [&_svg]:shrink-0 [&_svg]:stroke-[1.75]',
          tone === 'ok' && 'border-success/30 bg-success-soft text-success',
          tone === 'bad' && 'border-danger/30 bg-danger-soft text-danger',
          tone === 'muted' && 'border-border-strong bg-surface-2 text-muted',
        )}
      >
        {icon}
        {children}
      </span>
    </Tooltip>
  );
}

/**
 * OpenPGP status for a message: whether it was encrypted and what its signature says. Deliberately a labelled chip,
 * not the shield icon of the sender-authentication (SPF/DKIM/DMARC) badge: that one is about the domain, this one
 * is about the key.
 */
export function PgpBadge({ sig, encrypted }: { sig: SigState; encrypted?: boolean }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="OpenPGP status">
      {encrypted && (
        <Chip tone="muted" icon={<Lock size={13} />} label="Encrypted" tip="End-to-end encrypted with OpenPGP. Decrypted in this browser tab.">Encrypted</Chip>
      )}
      {sig.state === 'valid' && (
        <Chip
          tone="ok" icon={<PenLine size={13} />} label={`Signed by ${sig.fingerprint}`}
          tip={<>Good signature from key<br /><span className="tnum break-all">{groupFingerprint(sig.fingerprint)}</span></>}
        >
          Signed by <span className="tnum">{short(sig.fingerprint)}</span>
        </Chip>
      )}
      {sig.state === 'bad' && (
        <Chip
          tone="bad" icon={<TriangleAlert size={13} />} label="Bad signature"
          tip="The signature does not match this message. It may have been altered, or signed with an expired or revoked key."
        >
          Bad signature
        </Chip>
      )}
      {sig.state === 'unknown' && (
        <Chip
          tone="muted" icon={<KeyRound size={13} />} label="Unknown key"
          tip="Signed with a key that is not in your keyring, so the signature can't be checked. Import the sender's key in Settings, Security."
        >
          Unknown key
        </Chip>
      )}
    </div>
  );
}
