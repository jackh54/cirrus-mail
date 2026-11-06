import { useId, useState } from 'react';
import type { Identity } from '@shared/api';
import { LIMITS } from '@shared/api';
import { RecipientInput } from './RecipientInput';
import type { ComposeDraft } from './types';

interface Props {
  draft: ComposeDraft;
  identities: Identity[];
  onChange: (patch: Partial<ComposeDraft>) => void;
}

export function ComposeFields({ draft, identities, onChange }: Props) {
  const [showCc, setShowCc] = useState(draft.cc.length > 0);
  const [showBcc, setShowBcc] = useState(draft.bcc.length > 0);
  const fromId = useId();
  const subjectId = useId();

  const toggles = (
    <div className="flex shrink-0 gap-0.5 pt-0.5">
      {!showCc && (
        <button type="button" onClick={() => setShowCc(true)} className="h-6 rounded-[4px] px-1.5 text-[12px] text-muted hover:bg-hover hover:text-fg">
          Cc
        </button>
      )}
      {!showBcc && (
        <button type="button" onClick={() => setShowBcc(true)} className="h-6 rounded-[4px] px-1.5 text-[12px] text-muted hover:bg-hover hover:text-fg">
          Bcc
        </button>
      )}
    </div>
  );

  return (
    <div className="shrink-0">
      {identities.length > 1 && (
        <div className="flex h-9 items-center gap-2 border-b border-border px-4">
          <label htmlFor={fromId} className="w-9 shrink-0 text-[13px] text-faint">From</label>
          <select
            id={fromId}
            value={draft.from}
            onChange={(e) => onChange({ from: e.target.value })}
            className="min-w-0 flex-1 cursor-pointer bg-transparent text-[13px] text-fg outline-none"
          >
            {identities.map((i) => (
              <option key={i.email} value={i.email}>
                {i.name ? `${i.name} <${i.email}>` : i.email}
                {i.isAlias ? ' (alias)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      <RecipientInput label="To" value={draft.to} onChange={(to) => onChange({ to })} autoFocus={draft.to.length === 0} trailing={toggles} />
      {showCc && <RecipientInput label="Cc" value={draft.cc} onChange={(cc) => onChange({ cc })} />}
      {showBcc && <RecipientInput label="Bcc" value={draft.bcc} onChange={(bcc) => onChange({ bcc })} />}
      <div className="flex h-9 items-center gap-2 border-b border-border px-4">
        <label htmlFor={subjectId} className="sr-only">Subject</label>
        <input
          id={subjectId}
          value={draft.subject}
          maxLength={LIMITS.maxSubject}
          onChange={(e) => onChange({ subject: e.target.value })}
          placeholder="Subject"
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-fg outline-none placeholder:font-normal placeholder:text-faint"
        />
      </div>
    </div>
  );
}
