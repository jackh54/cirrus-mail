import { useState, type FormEvent } from 'react';
import { Ban, X } from 'lucide-react';
import { Button, IconButton } from '../../components/Button';
import { Input } from '../../components/Field';
import { Section } from '../../components/PageShell';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { relativeAgo } from '../../lib/format';
import { useBlocked, useBlockedMutations } from '../../lib/queries/settings';

export function BlockedSection({ mb }: { mb: string }) {
  const blocked = useBlocked(mb);
  const { add, remove } = useBlockedMutations(mb);
  const { toast } = useToast();
  const [pattern, setPattern] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = pattern.trim().toLowerCase();
    if (!p) return;
    add.mutate(p, {
      onSuccess: () => setPattern(''),
      onError: (err) => toast({ tone: 'error', title: 'Not blocked', description: errorMessage(err) }),
    });
  };

  return (
    <Section title="Blocked senders" description="Mail from these addresses or domains goes straight to Spam. Use @example.com to block a whole domain.">
      <form onSubmit={submit} className="mb-4 flex gap-2">
        <Input aria-label="Address or domain to block" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="spammer@example.com or @example.com" />
        <Button type="submit" loading={add.isPending} disabled={!pattern.trim()} icon={<Ban size={14} />}>Block</Button>
      </form>
      {blocked.data && blocked.data.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {blocked.data.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{b.pattern}</span>
              <span className="text-[12px] text-faint">{relativeAgo(b.createdAt)}</span>
              <IconButton label={`Unblock ${b.pattern}`} size="sm" onClick={() => remove.mutate(b.id)}>
                <X size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-faint">{blocked.isPending ? 'Loading…' : 'Nobody is blocked.'}</p>
      )}
    </Section>
  );
}
