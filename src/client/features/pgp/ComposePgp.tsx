import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Lock, PenLine } from 'lucide-react';
import type { Address } from '@shared/api';
import { IconButton } from '../../components/Button';
import { getUnlocked } from '../../lib/pgp/session';
import { usePgpKey, usePgpKeyring } from '../../lib/queries/pgp';
import type { ComposeDraft } from '../compose/types';
import { missingKeys, pgpModeOf, sealDraft } from './compose';
import { UnlockDialog } from './UnlockDialog';

/**
 * Compose's OpenPGP controls. `toggles` goes in the footer, `notice` above it and `dialog` anywhere.
 * `check` returns an error to show before sending; `seal` encrypts/signs the saved draft (false = not
 * needed, null = the user cancelled unlocking).
 */
export function usePgpCompose(draft: ComposeDraft, update: (patch: Partial<ComposeDraft>) => void, attachmentCount: number) {
  const key = usePgpKey().data;
  const keyring = usePgpKeyring().data ?? [];
  const [unlockOpen, setUnlockOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const recipients: Address[] = [...draft.to, ...draft.cc, ...draft.bcc];
  const missing = missingKeys(recipients, keyring);
  const hasKey = !!key && !key.revoked;
  const canEncrypt = hasKey && recipients.length > 0 && missing.length === 0;
  const on = !!(draft.pgpEncrypt || draft.pgpSign);

  const encryptWhy = !key ? 'Create a PGP key in Settings, Security first'
    : key.revoked ? 'Your PGP key is revoked'
    : !recipients.length ? 'Add recipients first'
    : missing.length ? `No PGP key for ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}`
    : '';

  const askUnlock = () =>
    new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setUnlockOpen(true);
    });
  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setUnlockOpen(false);
  }, []);

  const toggles: ReactNode = (
    <>
      <IconButton
        label={draft.pgpEncrypt ? 'Encrypt: on' : canEncrypt ? 'Encrypt (PGP)' : `Encrypt unavailable: ${encryptWhy}`}
        tipSide="top"
        active={draft.pgpEncrypt}
        aria-pressed={!!draft.pgpEncrypt}
        disabled={!draft.pgpEncrypt && !canEncrypt}
        onClick={() => update({ pgpEncrypt: !draft.pgpEncrypt })}
      >
        <Lock size={16} />
      </IconButton>
      <IconButton
        label={!hasKey ? 'Sign unavailable: create a PGP key in Settings, Security first' : draft.pgpSign ? 'Sign: on' : 'Sign (PGP)'}
        tipSide="top"
        active={draft.pgpSign}
        aria-pressed={!!draft.pgpSign}
        disabled={!draft.pgpSign && !hasKey}
        onClick={() => update({ pgpSign: !draft.pgpSign })}
      >
        <PenLine size={16} />
      </IconButton>
    </>
  );

  const notice: ReactNode = on ? (
    <p className="mx-4 mb-2 shrink-0 rounded-md bg-surface-2 px-3 py-2 text-[12px] leading-4 text-muted group-data-keyboard/sheet:hidden">
      {draft.pgpEncrypt ? 'Encrypted end to end' : 'Signed with your key'}
      {draft.pgpSign && draft.pgpEncrypt ? ' and signed' : ''}. Formatting is dropped: it is sent as plain text, and attachments are not allowed.
      {draft.pgpEncrypt && ' The subject and recipients stay visible.'}
      {draft.pgpEncrypt && !canEncrypt && encryptWhy ? ` Cannot encrypt yet: ${encryptWhy}.` : ''}
    </p>
  ) : null;

  const dialog: ReactNode = <UnlockDialog open={unlockOpen} onClose={() => settle(false)} onUnlocked={() => settle(true)} />;

  /** An error to show before sending, or null. */
  const check = (): string | null => {
    if (!on) return null;
    if (attachmentCount) return 'Encrypted or signed messages cannot have attachments. Remove them, or turn off Encrypt and Sign.';
    if (!hasKey) return 'Create (or restore) your PGP key in Settings, Security to encrypt or sign.';
    if (draft.pgpEncrypt && missing.length) return `No PGP key for ${missing.join(', ')}. Remove them or turn off Encrypt.`;
    return null;
  };

  const seal = async (draftId: string): Promise<boolean | null> => {
    if (!on || !key) return false;
    if (draft.pgpSign && getUnlocked()?.fingerprint !== key.fingerprint && !(await askUnlock())) return null;
    await sealDraft(draft, draftId, keyring, key);
    return true;
  };

  return { toggles, notice, dialog, check, seal, mode: pgpModeOf(draft) };
}
