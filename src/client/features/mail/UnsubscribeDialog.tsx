import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MessageFull, UnsubscribeInfo, UnsubscribeInput, UnsubscribeResponse } from '@shared/api';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries/keys';

interface Props {
  mailboxId: string;
  message: MessageFull;
  onClose: () => void;
}

function describe(info: UnsubscribeInfo): { body: string; confirm: string } {
  switch (info.method) {
    case 'one_click':
      return { body: `Cirrus will ask ${info.host} to remove you from this list. You will not need to open anything.`, confirm: 'Unsubscribe' };
    case 'mailto':
      return { body: `Cirrus will send a short unsubscribe email from this mailbox to ${info.host}. It counts toward your daily sending limit.`, confirm: 'Send unsubscribe email' };
    case 'link':
      return { body: `This opens the unsubscribe page of ${info.host} in a new tab. You may need to confirm there.`, confirm: 'Open unsubscribe page' };
  }
}

/** Confirms, then unsubscribes using the header stored with the message (the server never takes a URL from us). */
export function UnsubscribeDialog({ mailboxId, message: m, onClose }: Props) {
  const info = m.unsubscribe;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [block, setBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  if (!info) return null;
  const { body, confirm } = describe(info);

  const run = async () => {
    // A link is opened in the click itself: browsers block a window opened after an await.
    if (info.method === 'link' && info.url) window.open(info.url, '_blank', 'noopener,noreferrer');
    // Nothing to ask the server for: just open the page.
    if (info.method === 'link' && !block) return onClose();
    setBusy(true);
    try {
      const input: UnsubscribeInput = { blockSender: block };
      const res = await api.post<UnsubscribeResponse>(`/api/mailboxes/${mailboxId}/messages/${m.id}/unsubscribe`, input);
      if (res.blocked) void qc.invalidateQueries({ queryKey: qk.blocked(mailboxId) });
      if (info.method === 'link') return onClose();
      const text = res.ok
        ? info.method === 'one_click'
          ? `${info.host} accepted the request. It can take a few days to stop.`
          : `Unsubscribe email sent to ${info.host}. It can take a few days to stop.`
        : info.method === 'one_click'
          ? `${info.host} did not accept the request. Try again later, or open their unsubscribe page yourself.`
          : "The unsubscribe email could not be sent. Check Sending in the admin area, or write to the sender yourself.";
      setResult({ ok: res.ok, text: res.blocked ? `${text} ${m.from.email} is blocked.` : text });
      toast({ tone: res.ok ? 'success' : 'error', title: res.ok ? 'Unsubscribed' : "Couldn't unsubscribe" });
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={result ? (result.ok ? 'Unsubscribed' : "Couldn't unsubscribe") : `Unsubscribe from ${m.from.name || m.from.email}?`}
      description={result ? undefined : body}
      width={440}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose} data-autofocus="">Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void run()} data-autofocus="">{confirm}</Button>
          </>
        )
      }
    >
      {result ? (
        <p role="status" className={result.ok ? 'text-[13px] leading-5' : 'text-[13px] leading-5 text-danger'}>{result.text}</p>
      ) : (
        <label className="flex min-h-9 items-center gap-2.5 text-[13px] pointer-coarse:min-h-11">
          <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} className="size-3.5" />
          Also block {m.from.email}
        </label>
      )}
    </Dialog>
  );
}
