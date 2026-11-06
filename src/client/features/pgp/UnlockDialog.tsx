import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { setUnlocked } from '../../lib/pgp/session';
import { usePgpKey } from '../../lib/queries/pgp';

/**
 * Asks for the PGP passphrase and decrypts the stored private key in the browser. The passphrase never leaves
 * this component: it is not sent anywhere and not kept after the key is unlocked.
 */
export function UnlockDialog({ open, onClose, onUnlocked }: { open: boolean; onClose: () => void; onUnlocked?: () => void }) {
  const key = usePgpKey().data;
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPass('');
    setError(null);
    onClose();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!key || !pass) return;
    setBusy(true);
    setError(null);
    try {
      const { unlockPrivateKey } = await import('../../lib/pgp/crypto');
      setUnlocked({ key: await unlockPrivateKey(key.privateKey, pass), fingerprint: key.fingerprint });
      setPass('');
      onUnlocked?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock the key.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Unlock your PGP key"
      description="Your passphrase decrypts the key in this browser tab only. It is never sent to the server, and the key is forgotten when you lock it or close the tab."
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!pass || !key} onClick={() => void submit()}>Unlock</Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)}>
        <Field label="PGP passphrase" error={error}>
          {(id, d) => (
            <Input id={id} aria-describedby={d} type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
