import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Search, X } from 'lucide-react';
import { Kbd } from '../../components/Kbd';

export function SearchBox({ mailboxId, q }: { mailboxId: string; q: string }) {
  const [value, setValue] = useState(q);
  const navigate = useNavigate();
  useEffect(() => setValue(q), [q]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const s = value.trim();
    if (s) navigate(`/mail/${mailboxId}/search?q=${encodeURIComponent(s)}`);
  };

  return (
    <form role="search" onSubmit={submit} className="group relative w-40 shrink-0 focus-within:w-56 sm:w-48">
      <Search size={14} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
      <label htmlFor="cirrus-search" className="sr-only">Search mail</label>
      <input
        id="cirrus-search"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Search mail"
        autoComplete="off"
        className="h-7 w-full rounded-md border border-transparent bg-surface-2 pr-8 pl-7 text-[13px] text-fg placeholder:text-faint focus:border-primary focus:bg-bg focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
        {q ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => navigate(`/mail/${mailboxId}/inbox`)}
            className="inline-flex size-5 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
          >
            <X size={13} />
          </button>
        ) : (
          <span className="max-md:hidden group-focus-within:hidden"><Kbd>/</Kbd></span>
        )}
      </span>
    </form>
  );
}
