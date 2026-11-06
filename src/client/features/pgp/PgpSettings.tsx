import { useState } from 'react';
import { Download, Lock, LockOpen } from 'lucide-react';
import type { PgpOwnKey } from '@shared/api';
import { Button } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Dialog } from '../../components/Dialog';
import { Field, Input, Textarea } from '../../components/Field';
import { Section } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { longDate } from '../../lib/format';
import { lockNow, setUnlocked, useUnlocked } from '../../lib/pgp/session';
import { useMeData } from '../../lib/queries/me';
import { useDeletePgpKey, usePgpKey, useSavePgpKey } from '../../lib/queries/pgp';
import { PgpKeyring } from './PgpKeyring';
import { groupFingerprint } from './PgpBadge';
import { UnlockDialog } from './UnlockDialog';

const MIN_PASSPHRASE = 10;

export function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/pgp-keys' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Settings, Security: the user's own OpenPGP key, then their keyring of other people's keys. */
export default function PgpSettings() {
  const key = usePgpKey();
  return (
    <>
      <Section
        title="Encryption (PGP)"
        description="End-to-end encryption and signatures with OpenPGP. Your private key is encrypted with a passphrase in this browser before it is stored, so the server never sees the passphrase or the key itself."
      >
        {key.isPending ? (
          <Skeleton className="h-16" />
        ) : key.isError ? (
          <p className="text-[13px] text-danger">{errorMessage(key.error)}</p>
        ) : key.data ? (
          <OwnKey k={key.data} />
        ) : (
          <NoKey />
        )}
      </Section>
      <PgpKeyring />
    </>
  );
}

function PassphraseHint() {
  return (
    <p className="text-[12px] leading-4 text-muted">
      This is separate from your login password. If you forget it, the key cannot be recovered, so keep a backup of the exported key.
    </p>
  );
}

function NoKey() {
  const [mode, setMode] = useState<'create' | 'import'>('create');
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md bg-surface-2 p-0.5 text-[13px]" role="tablist" aria-label="Add a key">
        {(['create', 'import'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cn('h-7 rounded-[5px] px-3 font-medium', mode === m ? 'bg-bg text-fg shadow-sm' : 'text-muted hover:text-fg')}
          >
            {m === 'create' ? 'Generate a key' : 'Import a key'}
          </button>
        ))}
      </div>
      {mode === 'create' ? <CreateKey /> : <ImportKey />}
    </div>
  );
}

function useSaveAndUnlock() {
  const save = useSavePgpKey();
  const { toast } = useToast();
  return async (k: { publicKey: string; privateKey: string; addresses: string[] }, passphrase: string, title: string) => {
    const saved = await save.mutateAsync(k);
    if (saved) {
      const { unlockPrivateKey } = await import('../../lib/pgp/crypto');
      setUnlocked({ key: await unlockPrivateKey(saved.privateKey, passphrase), fingerprint: saved.fingerprint });
    }
    toast({ tone: 'success', title });
  };
}

function CreateKey() {
  const { user, mailboxes } = useMeData();
  const addresses = [...new Set(mailboxes.flatMap((m) => m.identities.map((i) => i.email.toLowerCase())))].sort();
  const [name, setName] = useState(user.name);
  const [chosen, setChosen] = useState<Set<string>>(new Set(addresses));
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saveAndUnlock = useSaveAndUnlock();

  const submit = async () => {
    setError(null);
    if (!chosen.size) return setError('Choose at least one address for the key.');
    if (pass.length < MIN_PASSPHRASE) return setError(`Use at least ${MIN_PASSPHRASE} characters for the passphrase.`);
    if (pass !== confirm) return setError('The passphrases do not match.');
    setBusy(true);
    try {
      const { generateKey } = await import('../../lib/pgp/crypto');
      const g = await generateKey({ name: name.trim() || user.name, emails: [...chosen], passphrase: pass });
      await saveAndUnlock(g, pass, 'PGP key created');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
      <Field label="Name on the key">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <fieldset className="space-y-1.5">
        <legend className="text-[13px] leading-5 font-medium">Addresses</legend>
        <p className="text-[12px] text-muted">The key gets a user ID for each address, so people can find it by the address they write to.</p>
        {addresses.map((a) => (
          <label key={a} className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={chosen.has(a)}
              onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(a); else n.delete(a); return n; })}
            />
            {a}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="PGP passphrase">{(id) => <Input id={id} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />}</Field>
        <Field label="Confirm passphrase">{(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
      </div>
      <PassphraseHint />
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} disabled={!pass || !confirm} onClick={() => void submit()}>Generate key</Button>
      </div>
    </div>
  );
}

function ImportKey() {
  const [armored, setArmored] = useState('');
  const [current, setCurrent] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saveAndUnlock = useSaveAndUnlock();

  const submit = async () => {
    setError(null);
    if (pass.length < MIN_PASSPHRASE) return setError(`Use at least ${MIN_PASSPHRASE} characters for the new passphrase.`);
    setBusy(true);
    try {
      const { importPrivateKey } = await import('../../lib/pgp/crypto');
      const g = await importPrivateKey(armored, current, pass);
      await saveAndUnlock(g, pass, 'PGP key imported');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
      <Field label="Armored private key" hint="Starts with -----BEGIN PGP PRIVATE KEY BLOCK-----. It is decrypted here, re-encrypted with the passphrase below, and only then uploaded.">
        {(id, d) => (
          <Textarea
            id={id} aria-describedby={d} rows={6} spellCheck={false} className="font-mono text-[12px]"
            value={armored} onChange={(e) => setArmored(e.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Key's current passphrase" hint="Leave empty if the key has none.">
          {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="off" value={current} onChange={(e) => setCurrent(e.target.value)} />}
        </Field>
        <Field label="PGP passphrase to use here">
          {(id) => <Input id={id} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />}
        </Field>
      </div>
      <PassphraseHint />
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} disabled={!armored.trim() || !pass} onClick={() => void submit()}>Import key</Button>
      </div>
    </div>
  );
}

function OwnKey({ k }: { k: PgpOwnKey }) {
  const unlocked = useUnlocked();
  const isUnlocked = unlocked?.fingerprint === k.fingerprint;
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const del = useDeletePgpKey();
  const confirm = useConfirm();
  const { toast } = useToast();

  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Fingerprint</dt>
        <dd className="tnum font-mono text-[12px] break-all">{groupFingerprint(k.fingerprint)}</dd>
        <dt className="text-muted">Addresses</dt>
        <dd>{k.addresses.length ? k.addresses.join(', ') : 'none'}</dd>
        <dt className="text-muted">Created</dt>
        <dd>{longDate(k.createdAt)}</dd>
        <dt className="text-muted">Status</dt>
        <dd className={k.revoked ? 'text-danger' : undefined}>{k.revoked ? 'Revoked. It can no longer be used to encrypt or sign.' : 'Active'}</dd>
        <dt className="text-muted">In this tab</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {isUnlocked ? <span className="text-success">Unlocked</span> : <span>Locked</span>}
          {isUnlocked ? (
            <Button size="sm" variant="secondary" icon={<Lock size={13} />} onClick={lockNow}>Lock now</Button>
          ) : (
            <Button size="sm" variant="secondary" icon={<LockOpen size={13} />} onClick={() => setUnlockOpen(true)}>Unlock</Button>
          )}
        </dd>
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Download size={13} />} onClick={() => download(`${k.fingerprint.slice(-16)}-public.asc`, k.publicKey)}>Export public key</Button>
        <Button
          size="sm"
          icon={<Download size={13} />}
          onClick={() => download(`${k.fingerprint.slice(-16)}-private.asc`, k.privateKey)}
          title="Still encrypted with your passphrase"
        >
          Export private key
        </Button>
        {!k.revoked && <Button size="sm" variant="ghost" className="text-danger" onClick={() => setRevokeOpen(true)}>Revoke…</Button>}
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          loading={del.isPending}
          onClick={async () => {
            const ok = await confirm({
              title: 'Delete your PGP key?',
              body: 'It is removed from the server. Messages already encrypted to it can only be read if you have a backup of the exported key.',
              confirmLabel: 'Delete key',
              danger: true,
            });
            if (!ok) return;
            del.mutate(undefined, {
              onSuccess: () => { lockNow(); toast({ title: 'PGP key deleted' }); },
              onError: (e) => toast({ tone: 'error', title: 'Could not delete the key', description: errorMessage(e) }),
            });
          }}
        >
          Delete…
        </Button>
      </div>
      <p className="text-[12px] text-muted">The exported private key stays encrypted with your passphrase.</p>

      <UnlockDialog open={unlockOpen} onClose={() => setUnlockOpen(false)} />
      <RevokeDialog k={k} open={revokeOpen} onClose={() => setRevokeOpen(false)} />
    </div>
  );
}

function RevokeDialog({ k, open, onClose }: { k: PgpOwnKey; open: boolean; onClose: () => void }) {
  const save = useSavePgpKey();
  const { toast } = useToast();
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPass('');
    setError(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { revokeStoredKey } = await import('../../lib/pgp/crypto');
      const r = await revokeStoredKey(k.privateKey, pass);
      await save.mutateAsync({ publicKey: r.publicKey, privateKey: r.privateKey, addresses: k.addresses, revoked: true });
      lockNow();
      toast({ title: 'Key revoked', description: 'Send people the exported public key so they stop using it.' });
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Revoke this key?"
      description="A revoked key can never be used again, and people who receive the revoked public key will stop encrypting to it. This cannot be undone."
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!pass} onClick={() => void submit()}>Revoke key</Button>
        </>
      }
    >
      <Field label="PGP passphrase" error={error}>
        {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
