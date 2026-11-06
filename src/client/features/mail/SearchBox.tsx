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
    <form role="search" onSubmit={submit} className="group relative flex-1">
      <Search size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
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
        className="h-8 w-full rounded-lg border border-transparent bg-surface-2 pr-14 pl-8 text-[13.5px] text-fg placeholder:text-faint transition-[border-color,background-color,box-shadow] duration-150 focus:border-primary focus:bg-surface focus:outline-none focus:ring-3 focus:ring-ring/30 [&::-webkit-search-cancel-button]:hidden"
      />
      <span className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
        {q ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => navigate(`/mail/${mailboxId}/inbox`)}
            className="rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        ) : (
          <span className="max-md:hidden group-focus-within:hidden"><Kbd>/</Kbd></span>
        )}
      </span>
    </form>
  );
}
