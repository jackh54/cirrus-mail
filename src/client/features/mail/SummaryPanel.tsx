import { useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '../../components/Button';
import { errorMessage } from '../../lib/api';
import { useCachedSummary, useSummarize } from '../../lib/queries/ai';

/** Fired by the command palette to summarise the open conversation. */
export const SUMMARISE_EVENT = 'cirrus:summarise';

interface Props {
  mailboxId: string;
  threadId: string;
  /** Run as soon as the cached lookup says there is nothing fresh (palette request). */
  autostart: boolean;
}

/** On-demand AI summary of a long conversation: a button, then a few bullets (cached on the server per thread). */
export function SummaryPanel({ mailboxId, threadId, autostart }: Props) {
  const cached = useCachedSummary(mailboxId, threadId, true);
  const run = useSummarize(mailboxId, threadId);
  const summary = cached.data ?? run.data ?? null;
  const { mutate, isPending } = run;

  const started = useRef(false);
  useEffect(() => {
    if (!autostart || started.current || !cached.isSuccess) return;
    started.current = true;
    if (!cached.data) mutate();
  }, [autostart, cached.isSuccess, cached.data, mutate]);

  if (summary) {
    return (
      <section aria-label="Conversation summary" className="mb-4 rounded-[10px] border border-border bg-surface-2 px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-[13px] font-medium"><Sparkles size={14} strokeWidth={1.75} className="text-primary" /> Summary</h2>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] leading-5 marker:text-faint">
          {summary.bullets.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
        <p className="mt-2 text-[12px] text-faint">Written by AI and can be wrong.</p>
      </section>
    );
  }
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <Button size="sm" variant="ghost" icon={<Sparkles size={14} strokeWidth={1.75} />} loading={isPending} onClick={() => mutate()} className="border border-border">
        Summarise
      </Button>
      {run.isError && <p role="alert" className="text-[12px] text-danger">{errorMessage(run.error)}</p>}
    </div>
  );
}
