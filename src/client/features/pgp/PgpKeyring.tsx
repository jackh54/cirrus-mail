import { useState } from 'react';
import { Search, TriangleAlert } from 'lucide-react';
import type { PgpKeyringEntry, PgpSource } from '@shared/api';
import { Button } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Field, Input, Textarea } from '../../components/Field';
import { Section } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage, isApiError } from '../../lib/api';
import { relativeAgo } from '../../lib/format';
import {
  useAcceptPendingKey, useDeleteKeyringKey, useDismissPendingKey, useImportKeyringKey, usePgpKeyring, useWkdLookup,
} from '../../lib/queries/pgp';
import { groupFingerprint } from './PgpBadge';

const SOURCE: Record<PgpSource, string> = { manual: 'Imported', autocrypt: 'Autocrypt', wkd: 'Web Key Directory' };

/** Other people's public keys: who has one, where it came from, and a warning when a key changes. */
export function PgpKeyring() {
  const ring = usePgpKeyring();
  return (
    <Section
      title="PGP keyring"
      description="Public keys of the people you write to. Autocrypt keys from verified senders are saved automatically. A key that changes is never swapped in silently: you decide."
    >
      <div className="space-y-6">
        {ring.isPending ? (
          <Skeleton className="h-12" />
        ) : ring.isError ? (
          <p className="text-[13px] text-danger">{errorMessage(ring.error)}</p>
        ) : ring.data.length ? (
          <ul className="divide-y divide-border">
            {ring.data.map((e) => <Row key={e.id} e={e} />)}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">No keys yet. Import one below, look an address up, or receive mail from someone who uses Autocrypt.</p>
        )}
        <Lookup />
        <ImportForm />
      </div>
    </Section>
  );
}

function Row({ e }: { e: PgpKeyringEntry }) {
  const accept = useAcceptPendingKey();
  const dismiss = useDismissPendingKey();
  const remove = useDeleteKeyringKey();
  const confirm = useConfirm();
  const { toast } = useToast();
  const fail = (title: string) => (err: unknown) => toast({ tone: 'error', title, description: errorMessage(err) });

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{e.email}</p>
          <p className="tnum font-mono text-[12px] break-all text-muted">{groupFingerprint(e.fingerprint)}</p>
          <p className="text-[12px] text-faint">{SOURCE[e.source]}, updated {relativeAgo(e.updatedAt)}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          loading={remove.isPending}
          onClick={async () => {
            if (await confirm({ title: `Remove the key for ${e.email}?`, body: 'You will not be able to encrypt to them until you add a key again.', confirmLabel: 'Remove', danger: true })) {
              remove.mutate(e.id, { onError: fail('Could not remove the key') });
            }
          }}
        >
          Remove
        </Button>
      </div>
      {e.pending && (
        <div role="alert" className="mt-2 rounded-md bg-warning-soft px-3 py-2 text-[13px] text-warning">
          <p className="flex items-center gap-2 font-medium"><TriangleAlert size={15} strokeWidth={1.75} className="shrink-0" /> A different key was seen for {e.email}</p>
          <p className="mt-1 text-[12px] leading-4">It came from {SOURCE[e.pending.source]} {relativeAgo(e.pending.at)}. Unless you expected {e.email} to change keys, treat this as suspicious.</p>
          <p className="tnum mt-1 font-mono text-[12px] break-all">Current: {groupFingerprint(e.fingerprint)}</p>
          <p className="tnum font-mono text-[12px] break-all">New: {groupFingerprint(e.pending.fingerprint)}</p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm" variant="secondary" loading={accept.isPending}
              onClick={() => accept.mutate(e.id, { onError: fail('Could not accept the key'), onSuccess: () => toast({ title: 'New key accepted' }) })}
            >
              Trust the new key
            </Button>
            <Button size="sm" variant="ghost" loading={dismiss.isPending} onClick={() => dismiss.mutate(e.id, { onError: fail('Could not dismiss') })}>Keep the current key</Button>
          </div>
        </div>
      )}
    </li>
  );
}

function Lookup() {
  const [email, setEmail] = useState('');
  const lookup = useWkdLookup();
  const { toast } = useToast();

  const run = () =>
    lookup.mutate(email.trim().toLowerCase(), {
      onSuccess: (r) => {
        setEmail('');
        if (r.status === 'pending') toast({ tone: 'error', title: 'A different key was found', description: 'The key from the directory differs from the one you have. Review it in the list.', duration: 8000 });
        else toast({ tone: 'success', title: r.status === 'unchanged' ? 'Key is up to date' : 'Key found', description: groupFingerprint(r.entry.fingerprint) });
      },
      onError: (e) => toast({ tone: 'error', title: isApiError(e) && e.status === 404 ? 'No key published' : 'Lookup failed', description: errorMessage(e) }),
    });

  return (
    <form onSubmit={(ev) => { ev.preventDefault(); run(); }} className="flex flex-wrap items-end gap-2">
      <Field label="Look up by address" hint="Asks the address's own domain for a published key (Web Key Directory)." className="min-w-0 flex-1 basis-64">
        {(id, d) => <Input id={id} aria-describedby={d} type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Button type="submit" icon={<Search size={14} />} loading={lookup.isPending} disabled={!email.trim()}>Look up</Button>
    </form>
  );
}

function ImportForm() {
  const [email, setEmail] = useState('');
  const [armored, setArmored] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const imp = useImportKeyringKey();
  const confirm = useConfirm();
  const { toast } = useToast();

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const addr = email.trim().toLowerCase();
      const { describePublicKey } = await import('../../lib/pgp/crypto');
      const info = await describePublicKey(armored.trim()).catch(() => {
        throw new Error('That is not a valid armored PGP public key.');
      });
      if (info.revoked) throw new Error('That key has been revoked.');
      if (!info.emails.includes(addr) && !(await confirm({
        title: 'The key has no user ID for this address',
        body: `It is for ${info.emails.join(', ') || 'no email address'}. Use it for ${addr} anyway?`,
        confirmLabel: 'Use it anyway',
      }))) return;
      try {
        await imp.mutateAsync({ email: addr, publicKey: armored.trim() });
      } catch (e) {
        if (!(isApiError(e) && e.code === 'KEY_CHANGED')) throw e;
        const d = e.details as { existingFingerprint?: string; newFingerprint?: string } | undefined;
        const ok = await confirm({
          title: `Replace the key for ${addr}?`,
          body: (
            <>
              A different key is already saved. Only continue if {addr} told you they changed keys.
              <span className="tnum mt-2 block font-mono text-[12px] break-all">Current: {groupFingerprint(d?.existingFingerprint ?? '')}</span>
              <span className="tnum block font-mono text-[12px] break-all">New: {groupFingerprint(d?.newFingerprint ?? info.fingerprint)}</span>
            </>
          ),
          confirmLabel: 'Replace key',
          danger: true,
        });
        if (!ok) return;
        await imp.mutateAsync({ email: addr, publicKey: armored.trim(), replace: true });
      }
      setEmail('');
      setArmored('');
      toast({ tone: 'success', title: 'Key saved', description: groupFingerprint(info.fingerprint) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-[13px] leading-5 font-medium">Import a public key</h3>
      {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
      <Field label="Address">{(id) => <Input id={id} type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label="Armored public key">
        {(id) => (
          <Textarea id={id} rows={5} spellCheck={false} className="font-mono text-[12px]" placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" value={armored} onChange={(e) => setArmored(e.target.value)} />
        )}
      </Field>
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} disabled={!email.trim() || !armored.trim()} onClick={() => void submit()}>Import key</Button>
      </div>
    </div>
  );
}
