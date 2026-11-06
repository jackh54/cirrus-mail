import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { linkify, splitQuotes } from '../../lib/text';

/** Plain text: preserved line breaks, linkified URLs, quoted `>` blocks collapsed behind "…". */
export function TextBody({ text }: { text: string }) {
  const blocks = splitQuotes(text);
  return (
    <div className="text-[14px] leading-relaxed break-words whitespace-pre-wrap text-fg">
      {blocks.map((b, i) => (b.kind === 'text' ? <Linked key={i} text={b.lines.join('\n')} /> : <Quote key={i} lines={b.lines} />))}
    </div>
  );
}

function Linked({ text }: { text: string }) {
  return (
    <div>
      {linkify(text).map((t, i) =>
        t.kind === 'text' ? (
          <span key={i}>{t.value}</span>
        ) : (
          <a key={i} href={t.href} target="_blank" rel="noopener noreferrer" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
            {t.value}
          </a>
        ),
      )}
    </div>
  );
}

function Quote({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Hide quoted text' : 'Show quoted text'}
        title={open ? 'Hide quoted text' : 'Show quoted text'}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-4 items-center rounded bg-surface-2 px-1.5 text-muted hover:bg-hover hover:text-fg"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border-strong pl-3 text-muted">
          <Linked text={lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n')} />
        </div>
      )}
    </div>
  );
}
