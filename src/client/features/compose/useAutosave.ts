import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/queries/keys';
import { draftApi } from './draftApi';
import { toDraftInput, type ComposeDraft } from './types';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const SAVE_EVERY_MS = 3000;

/**
 * Autosave: the first change creates the draft immediately, later changes are PUT at most every
 * 3 s while the content keeps changing. `rev` increments on every user edit.
 */
export function useAutosave(draft: ComposeDraft, rev: number, onDraftId: (id: string) => void) {
  const qc = useQueryClient();
  const latest = useRef({ draft, rev });
  latest.current = { draft, rev };
  const draftId = useRef<string | null>(draft.draftId);
  const savedRev = useRef(0);
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);
  const [status, setStatus] = useState<SaveStatus>(draft.draftId ? 'saved' : 'idle');
  const onDraftIdRef = useRef(onDraftId);
  onDraftIdRef.current = onDraftId;

  const save = useCallback((): Promise<void> => {
    const run = async () => {
      if (inflight.current) await inflight.current.catch(() => undefined);
      const { draft: d, rev: r } = latest.current;
      if (r <= savedRev.current && draftId.current) return;
      setStatus('saving');
      try {
        const input = toDraftInput({ ...d, draftId: draftId.current });
        if (draftId.current) {
          await draftApi.update(d.mailboxId, draftId.current, input);
        } else {
          const m = await draftApi.create(d.mailboxId, input);
          draftId.current = m.id;
          onDraftIdRef.current(m.id);
          void qc.invalidateQueries({ queryKey: qk.folders(d.mailboxId) });
        }
        savedRev.current = r;
        setStatus('saved');
      } catch (e) {
        setStatus('error');
        throw e;
      }
    };
    const p = run().finally(() => {
      if (inflight.current === p) inflight.current = null;
    });
    inflight.current = p;
    return p;
  }, [qc]);

  useEffect(() => {
    if (rev === 0 || stopped.current) return;
    if (!draftId.current && !inflight.current) {
      void save().catch(() => undefined);
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!stopped.current) void save().catch(() => undefined);
    }, SAVE_EVERY_MS);
  }, [rev, save]);

  // After a save completes, keep going if edits arrived in the meantime.
  useEffect(() => {
    if (status !== 'saved' || stopped.current) return;
    if (latest.current.rev > savedRev.current && !timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!stopped.current) void save().catch(() => undefined);
      }, SAVE_EVERY_MS);
    }
  }, [status, save]);

  // Save on unmount if anything is unsaved (closing the sheet, opening another compose).
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (!stopped.current && latest.current.rev > savedRev.current) void save().catch(() => undefined);
    },
    [save],
  );

  /** Save now and return the draft id (creating the draft if needed). */
  const flush = useCallback(async (): Promise<string> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inflight.current) await inflight.current.catch(() => undefined);
    if (!draftId.current || latest.current.rev > savedRev.current) await save();
    if (!draftId.current) throw new Error('Draft could not be saved');
    return draftId.current;
  }, [save]);

  /** Stop autosaving (after send or discard). */
  const stop = useCallback(() => {
    stopped.current = true;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { status, flush, stop, draftId };
}
