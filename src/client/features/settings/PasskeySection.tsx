import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { PasskeyInfo } from '@shared/api';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { Section } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { relativeAgo } from '../../lib/format';
import { useAddPasskey, useDeletePasskey, usePasskeys, useRenamePasskey } from '../../lib/queries/passkeys';
import { isPasskeyCancel, passkeysSupported } from '../../lib/webauthn';

export function PasskeySection() {
  const passkeys = usePasskeys();
  const add = useAddPasskey();
  const rename = useRenamePasskey();
  const del = useDeletePasskey();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<PasskeyInfo | null>(null);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<PasskeyInfo | null>(null);

  // Browsers without WebAuthn get no passkey controls at all.
  if (!passkeysSupported()) return null;

  const closeAdd = () => {
    setAdding(false);
    setName('');
    setPassword('');
    setError(null);
  };

  const submitAdd = () => {
    setError(null);
    add.mutate({ password, name: name.trim() }, {
      onSuccess: () => {
        closeAdd();
        toast({ tone: 'success', title: 'Passkey added' });
      },
      // Dismissing the browser prompt is not a failure worth a message.
      onError: (e) => { if (!isPasskeyCancel(e)) setError(errorMessage(e)); },
    });
  };

  return (
    <Section
      title="Passkeys"
      description="Sign in with your fingerprint, face or device PIN instead of a password. A passkey with verification also replaces the authentication code."
      footer={<Button variant="primary" onClick={() => setAdding(true)}>Add a passkey</Button>}
    >
      {passkeys.isPending ? (
        <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      ) : passkeys.isError ? (
        <p className="text-[13px] text-danger">{errorMessage(passkeys.error)}</p>
      ) : passkeys.data.length === 0 ? (
        <p className="text-[13px] text-muted">No passkeys yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {passkeys.data.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted [&_svg]:stroke-[1.75]">
                <KeyRound size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{p.name}</p>
                <p className="text-[12px] text-muted">
                  Added {relativeAgo(p.createdAt)}, {p.lastUsedAt ? `last used ${relativeAgo(p.lastUsedAt)}` : 'never used'}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => { setRenaming(p); setNewName(p.name); }}>Rename</Button>
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => { setDeleting(p); setPassword(''); }}>Delete</Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={adding} onClose={closeAdd} title="Add a passkey" width={420}
        description="Confirm your password, then follow your browser's prompt."
        footer={<><Button variant="ghost" onClick={closeAdd}>Cancel</Button><Button variant="primary" loading={add.isPending} disabled={!password} onClick={submitAdd}>Continue</Button></>}
      >
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (password && !add.isPending) submitAdd(); }}>
          <Field label="Current password" error={error}>
            {(id, d) => <Input id={id} aria-describedby={d} aria-invalid={!!error} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Field label="Name (optional)">
            {(id) => <Input id={id} maxLength={60} placeholder="e.g. MacBook, iPhone" value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
        </form>
      </Dialog>

      <Dialog open={!!renaming} onClose={() => setRenaming(null)} title="Rename passkey" width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={rename.isPending}
              disabled={!newName.trim()}
              onClick={() => renaming && rename.mutate({ id: renaming.id, name: newName.trim() }, {
                onSuccess: () => setRenaming(null),
                onError: (e) => toast({ tone: 'error', title: 'Could not rename', description: errorMessage(e) }),
              })}
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Name">
          {(id) => <Input id={id} maxLength={60} autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />}
        </Field>
      </Dialog>

      <Dialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete this passkey?" width={420}
        description={deleting ? `"${deleting.name}" will no longer sign in to your account.` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={del.isPending}
              disabled={!password}
              onClick={() => deleting && del.mutate({ id: deleting.id, password }, {
                onSuccess: () => {
                  setDeleting(null);
                  setPassword('');
                  toast({ title: 'Passkey deleted' });
                },
                onError: (e) => toast({ tone: 'error', title: 'Not deleted', description: errorMessage(e) }),
              })}
            >
              Delete
            </Button>
          </>
        }
      >
        <Field label="Confirm with your password">
          {(id) => <Input id={id} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
      </Dialog>
    </Section>
  );
}
