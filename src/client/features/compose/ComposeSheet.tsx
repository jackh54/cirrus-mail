import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Check, CloudOff, Maximize2, Minimize2, Minus, Paperclip, Trash2, X } from 'lucide-react';
import type { Address } from '@shared/api';
import { LIMITS } from '@shared/api';
import { IconButton } from '../../components/Button';
import { SendingNotice } from '../../components/SendingNotice';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/Confirm';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/api';
import { isValidEmail } from '../../lib/format';
import { useMeData } from '../../lib/queries/me';
import { useMediaQuery } from '../mail/useMailRoute';
import { identitiesOf } from './identities';
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

/** Keyboard taller than this means the on-screen keyboard is up (not just the browser toolbar moving). */
const KEYBOARD_PX = 120;

/**
 * Phones: the on-screen keyboard shrinks the visual viewport but not the layout viewport, so a
 * `fixed inset-0` sheet would hide its toolbar and Send behind it. Track the visual viewport and
 * size the sheet to it.
 */
function useVisualViewport(enabled: boolean): { style: CSSProperties | undefined; keyboard: boolean } {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) {
      setBox(null);
      return;
    }
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBox({ top: vv.offsetTop, height: vv.height }));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [enabled]);
  if (!box) return { style: undefined, keyboard: false };
  return {
    style: { top: box.top, height: box.height, bottom: 'auto' },
    keyboard: window.innerHeight - box.height > KEYBOARD_PX,
  };
}

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
  const mobile = useMediaQuery('(max-width: 767px)');
  const viewport = useVisualViewport(mobile && mode !== 'min');

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
      style={viewport.style}
      data-keyboard={viewport.keyboard ? '' : undefined}
      className={cn(
        'group/sheet fixed z-50 flex flex-col overflow-hidden bg-elevated shadow-pop animate-pop-in',
        // Phones: full screen, padded under the status bar and clear of the notch in landscape.
        'inset-0 max-md:overscroll-contain max-md:pt-[env(safe-area-inset-top)] max-md:pr-[env(safe-area-inset-right)] max-md:pl-[env(safe-area-inset-left)]',
        'md:inset-auto md:right-4 md:bottom-0 md:rounded-t-[10px]',
        mode === 'normal' && 'md:h-[min(600px,calc(100dvh-72px))] md:w-[560px]',
        mode === 'max' && 'md:top-[6vh] md:right-[8vw] md:bottom-[6vh] md:left-[8vw] md:rounded-[10px]',
        mode === 'min' && 'max-md:inset-auto max-md:right-3 max-md:bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-md:left-3 max-md:rounded-[10px] max-md:pt-0 md:w-80',
      )}
    >
      <header
        className="flex h-10 shrink-0 cursor-default items-center gap-1 border-b border-border pr-2 pl-4 max-md:h-12 max-md:gap-2 max-md:pr-3"
        onDoubleClick={() => setMode((m) => (m === 'min' ? 'normal' : 'min'))}
      >
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium max-md:text-[15px] max-md:font-semibold">{title}</h2>
        <SaveIndicator status={autosave.status} />
        <IconButton label={mode === 'min' ? 'Restore' : 'Minimise'} onClick={() => setMode((m) => (m === 'min' ? 'normal' : 'min'))}>
          <Minus size={16} />
        </IconButton>
        <IconButton label={mode === 'max' ? 'Exit full size' : 'Full size'} className="max-md:hidden" onClick={() => setMode((m) => (m === 'max' ? 'normal' : 'max'))}>
          {mode === 'max' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
        <IconButton label="Save and close" tipAlign="end" onClick={close}>
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
            <p role="alert" className="mx-4 mb-2 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}
          <SendingNotice className="mx-4 mb-2 shrink-0 group-data-keyboard/sheet:hidden" />
          {/* With the keyboard up it covers the home indicator, so the safe-area padding goes away. */}
          <footer className="flex shrink-0 items-center gap-1 px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))] group-data-keyboard/sheet:pb-2 max-md:gap-2">
            <SendButton onSend={(at) => void send(at)} busy={sending} disabled={files.busy} />
            <IconButton label="Attach files" tipSide="top" className="ml-1" onClick={() => fileInput.current?.click()}>
              <Paperclip size={16} />
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
            <IconButton label="Discard draft" tipSide="top" tipAlign="end" onClick={() => void discard()}>
              <Trash2 size={16} />
            </IconButton>
          </footer>
        </>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 top-12 flex items-center justify-center rounded-md border border-dashed border-primary bg-elevated/95 text-[13px] font-medium text-selected-fg">
          Drop files to attach
        </div>
      )}
    </section>
  );
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === 'idle') return null;
  return (
    <span className="mr-1 flex items-center gap-1 text-[12px] text-faint" aria-live="polite">
      {status === 'saving' && <><Spinner size={11} /> Saving</>}
      {status === 'saved' && <><Check size={12} /> Saved</>}
      {status === 'error' && <span className="flex items-center gap-1 text-danger"><CloudOff size={12} /> Not saved</span>}
    </span>
  );
}
