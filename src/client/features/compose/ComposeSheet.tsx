import { useCallback, useRef, useState, type DragEvent } from 'react';
import { Check, CloudOff, Maximize2, Minimize2, Minus, Paperclip, Trash2, X } from 'lucide-react';
import type { Address } from '@shared/api';
import { LIMITS } from '@shared/api';
import { IconButton } from '../../components/Button';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/Confirm';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/api';
import { isValidEmail } from '../../lib/format';
import { useMeData } from '../../lib/queries/me';
import { identitiesOf } from './prefill';
import { useCompose } from './ComposeProvider';
import { useAutosave, type SaveStatus } from './useAutosave';
import { useAttachments } from './useAttachments';
import { draftApi } from './draftApi';
import { AttachmentList } from './AttachmentList';
import { ComposeFields } from './ComposeFields';
import { RichEditor } from './RichEditor';
import { SendButton } from './SendButton';
import type { ComposeDraft } from './types';

type Mode = 'normal' | 'min' | 'max';

export function ComposeSheet({ initial }: { initial: ComposeDraft }) {
  const { mailboxes } = useMeData();
  const compose = useCompose();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState(initial);
  const [rev, setRev] = useState(0);
  const [mode, setMode] = useState<Mode>('normal');
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const mailbox = mailboxes.find((m) => m.id === draft.mailboxId) ?? mailboxes[0];
  const autosave = useAutosave(draft, rev, (id) => setDraft((d) => ({ ...d, draftId: id })));
  const noop = useCallback(() => undefined, []);
  const files = useAttachments(draft.mailboxId, initial.attachments, autosave.flush, noop);

  const update = useCallback((patch: Partial<ComposeDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setRev((r) => r + 1);
    setError(null);
  }, []);

  const recipients: Address[] = [...draft.to, ...draft.cc, ...draft.bcc];
  const invalid = recipients.filter((a) => !isValidEmail(a.email));

  const send = async (sendAt?: number) => {
    if (!recipients.length) return setError('Add at least one recipient.');
    if (invalid.length) return setError(`Fix the invalid address${invalid.length > 1 ? 'es' : ''}: ${invalid.map((a) => a.email).join(', ')}`);
    if (recipients.length > LIMITS.maxRecipients) return setError(`A message can have at most ${LIMITS.maxRecipients} recipients.`);
    if (files.busy) return setError('Wait for attachments to finish uploading.');
    if (!draft.subject.trim() && !(await confirm({ title: 'Send without a subject?', confirmLabel: 'Send anyway' }))) return;
    setSending(true);
    try {
      const draftId = await autosave.flush();
      autosave.stop();
      compose.queueSend({ ...draft, draftId, attachments: files.attachments }, sendAt);
    } catch (e) {
      setError(errorMessage(e));
      setSending(false);
    }
  };

  const close = () => {
    if (rev > 0 || draft.draftId) toast({ title: 'Draft saved', duration: 2500 });
    compose.close();
  };

  const discard = async () => {
    autosave.stop();
    compose.close();
    const id = autosave.draftId.current;
    if (id) {
      try {
        await draftApi.discard(draft.mailboxId, id);
      } catch {
        /* already gone */
      }
    }
    toast({ title: 'Draft discarded', duration: 2500 });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void files.addFiles(Array.from(e.dataTransfer.files));
  };

  const title = draft.subject.trim() || (draft.composeMode === 'new' ? 'New message' : draft.composeMode === 'forward' ? 'Forward' : 'Reply');

  return (
    <section
      aria-label={title}
      data-hotkeys="off"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void send();
        }
        if (e.key === 'Escape' && mode === 'max') setMode('normal');
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
      className={cn(
        'fixed z-50 flex flex-col overflow-hidden bg-elevated shadow-pop animate-rise-in',
        'inset-0 md:inset-auto md:right-5 md:bottom-0 md:rounded-t-2xl md:border md:border-b-0 md:border-border',
        mode === 'normal' && 'md:h-[min(620px,calc(100dvh-80px))] md:w-[560px]',
        mode === 'max' && 'md:top-[6vh] md:right-[8vw] md:bottom-[6vh] md:left-[8vw] md:rounded-2xl md:border-b',
        mode === 'min' && 'max-md:inset-auto max-md:right-3 max-md:bottom-3 max-md:left-3 max-md:rounded-xl md:w-80',
      )}
    >
      <header
        className="flex h-11 shrink-0 cursor-default items-center gap-2 border-b border-border bg-surface-2 pr-1.5 pl-4"
        onDoubleClick={() => setMode((m) => (m === 'min' ? 'normal' : 'min'))}
      >
        <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{title}</h2>
        <SaveIndicator status={autosave.status} />
        <IconButton size="sm" label={mode === 'min' ? 'Restore' : 'Minimise'} onClick={() => setMode((m) => (m === 'min' ? 'normal' : 'min'))}>
          <Minus size={15} />
        </IconButton>
        <IconButton size="sm" label={mode === 'max' ? 'Exit full size' : 'Full size'} className="max-md:hidden" onClick={() => setMode((m) => (m === 'max' ? 'normal' : 'max'))}>
          {mode === 'max' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
        <IconButton size="sm" label="Save and close" onClick={close}>
          <X size={16} />
        </IconButton>
      </header>

      {mode !== 'min' && (
        <>
          <ComposeFields draft={draft} identities={identitiesOf(mailbox)} onChange={update} />
          <RichEditor
            initialHtml={initial.html}
            onChange={(html) => update({ html })}
            autofocus={draft.composeMode !== 'new' && draft.to.length > 0}
            className="min-h-0 flex-1"
          />
          <AttachmentList
            attachments={files.attachments}
            uploads={files.uploads}
            onRemove={(a) => void files.remove(a, autosave.draftId.current)}
            onDismissUpload={files.dismissUpload}
          />
          {error && (
            <p role="alert" className="mx-4 mb-2 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}
          <footer className="flex shrink-0 items-center gap-1 border-t border-border px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
            <SendButton onSend={(at) => void send(at)} busy={sending} disabled={files.busy} />
            <IconButton label="Attach files" className="ml-1" onClick={() => fileInput.current?.click()}>
              <Paperclip size={17} />
            </IconButton>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void files.addFiles(Array.from(e.target.files));
                e.target.value = '';
              }}
            />
            <span className="flex-1" />
            <IconButton label="Discard draft" onClick={() => void discard()}>
              <Trash2 size={16} />
            </IconButton>
          </footer>
        </>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 top-12 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary-soft/90 text-sm font-medium text-primary">
          Drop files to attach
        </div>
      )}
    </section>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === 'idle') return null;
  return (
    <span className="flex items-center gap-1 text-xs text-faint" aria-live="polite">
      {status === 'saving' && <><Spinner size={11} /> Saving</>}
      {status === 'saved' && <><Check size={12} /> Saved</>}
      {status === 'error' && <span className="flex items-center gap-1 text-danger"><CloudOff size={12} /> Not saved</span>}
    </span>
  );
}
