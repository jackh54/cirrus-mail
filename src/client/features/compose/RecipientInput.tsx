import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type { Address, Contact } from '@shared/api';
import { cn } from '../../lib/cn';
import { displayName, formatAddress, isValidEmail, parseAddressList } from '../../lib/format';
import { useContacts } from '../../lib/queries/mail';

interface Props {
  label: string;
  value: Address[];
  onChange: (v: Address[]) => void;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** Recipient chips with contact autocomplete, comma/paste splitting and validation styling. */
export function RecipientInput({ label, value, onChange, autoFocus, trailing }: Props) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const q = useDebounced(text.trim(), 150);
  const contacts = useContacts(q);
  const taken = new Set(value.map((a) => a.email.toLowerCase()));
  const suggestions: Contact[] = (contacts.data ?? []).filter((c) => !taken.has(c.email.toLowerCase())).slice(0, 8);
  const showList = focused && text.trim().length > 0 && suggestions.length > 0;

  const add = (list: Address[]) => {
    const fresh = list.filter((a) => a.email && !taken.has(a.email.toLowerCase()));
    if (fresh.length) onChange([...value, ...fresh]);
    setText('');
    setActive(0);
  };

  const commitText = () => {
    if (text.trim()) add(parseAddressList(text));
  };

  const pick = (c: Contact) => {
    add([{ email: c.email, name: c.name || undefined }]);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (showList && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ';') {
      if (showList && (e.key === 'Enter' || e.key === 'Tab')) {
        e.preventDefault();
        pick(suggestions[active] ?? suggestions[0]);
        return;
      }
      if (text.trim()) {
        e.preventDefault();
        commitText();
      }
      return;
    }
    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
    if (e.key === 'Escape' && text) {
      e.stopPropagation();
      setText('');
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const s = e.clipboardData.getData('text');
    if (/[,;\n]/.test(s) || s.includes('@')) {
      e.preventDefault();
      add(parseAddressList(text + s));
    }
  };

  return (
    <div className="relative flex min-h-9 items-start gap-2 border-b border-border px-4 py-1 pointer-coarse:min-h-11 pointer-coarse:py-2">
      <label htmlFor={`${listId}-input`} className="w-9 shrink-0 pt-1.5 text-[13px] text-faint">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((a, i) => {
          const valid = isValidEmail(a.email);
          return (
            <span
              key={`${a.email}-${i}`}
              title={formatAddress(a)}
              className={cn(
                'inline-flex h-6 max-w-full items-center gap-0.5 rounded-[4px] pr-0.5 pl-1.5 text-[13px] pointer-coarse:h-7 pointer-coarse:text-[15px]',
                valid ? 'bg-surface-2 text-fg' : 'bg-danger-soft text-danger ring-1 ring-danger/40',
              )}
            >
              <span className="truncate">{a.name ? displayName(a) : a.email}</span>
              <button
                type="button"
                aria-label={`Remove ${a.email}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="cm-hit inline-flex size-4 items-center justify-center rounded-[3px] text-faint hover:bg-hover hover:text-fg pointer-coarse:size-6"
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          id={`${listId}-input`}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commitText();
          }}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          autoComplete="off"
          className="h-7 min-w-24 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
        />
      </div>
      {trailing}
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full left-14 z-20 mt-1 w-72 max-w-[calc(100%-4rem)] overflow-hidden rounded-[10px] bg-elevated p-1 shadow-pop animate-pop-in"
        >
          {suggestions.map((c, i) => (
            <li
              key={c.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('cursor-pointer rounded-md px-2 py-1 pointer-coarse:py-2', i === active && 'bg-hover')}
            >
              <div className="truncate text-[13px] leading-5 text-fg">{c.name || c.email}</div>
              {c.name && <div className="truncate text-[12px] leading-4 text-muted">{c.email}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
