import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { Globe, Plus, Stethoscope, Trash2 } from 'lucide-react';
import type { AdminMailbox, Domain } from '@shared/api';
import { Button, IconButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { EmptyState } from '../../components/EmptyState';
import { Input, Select } from '../../components/Field';
import { PageTitle } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { useAdminDomains, useAdminMailboxes, useDomainMutations } from '../../lib/queries/admin';
import { DomainCheckPanel } from './DomainCheckPanel';
import { SetupGuide } from './SetupGuide';

export function DomainsPage() {
  const domains = useAdminDomains();
  const mailboxes = useAdminMailboxes();
  const { create } = useDomainMutations();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const { hash } = useLocation();

  useEffect(() => {
    if (hash === '#guide') setTimeout(() => document.getElementById('guide')?.scrollIntoView({ behavior: 'smooth' }), 100);
  }, [hash]);

  const add = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(n)) return toast({ tone: 'error', title: 'That does not look like a domain', description: 'Use something like example.com.' });
    create.mutate(n, {
      onSuccess: () => setName(''),
      onError: (err) => toast({ tone: 'error', title: 'Domain not added', description: errorMessage(err) }),
    });
  };

  return (
    <>
      <PageTitle title="Domains" description="Domains this instance receives mail for. Each must be on your Cloudflare account." />
      <form onSubmit={add} className="mb-6 flex max-w-md gap-2">
        <Input aria-label="Domain name" value={name} onChange={(e) => setName(e.target.value)} placeholder="example.com" />
        <Button type="submit" variant="primary" icon={<Plus size={15} strokeWidth={1.75} />} loading={create.isPending} disabled={!name.trim()}>Add domain</Button>
      </form>
      {domains.isPending ? (
        <Skeleton className="h-16 rounded-[10px]" />
      ) : domains.isError ? (
        <p className="text-[13px] text-danger">{errorMessage(domains.error)}</p>
      ) : domains.data.length === 0 ? (
        <div className="mb-8 rounded-[10px] border border-dashed border-border-strong">
          <EmptyState icon={<Globe size={24} />} title="No domains yet" body="Add the domain you want to receive mail on, then follow the setup guide below." />
        </div>
      ) : (
        <ul className="mb-10 divide-y divide-border overflow-hidden rounded-[10px] border border-border">
          {domains.data.map((d) => <DomainCard key={d.id} domain={d} mailboxes={(mailboxes.data ?? []).filter((m) => m.domainId === d.id)} />)}
        </ul>
      )}
      <SetupGuide />
    </>
  );
}

function DomainCard({ domain, mailboxes }: { domain: Domain; mailboxes: AdminMailbox[] }) {
  const { update, remove } = useDomainMutations();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);

  return (
    <li>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Globe size={16} strokeWidth={1.75} className="shrink-0 text-faint" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{domain.name}</p>
          <p className="tnum text-[12px] text-muted">{domain.mailboxCount} mailbox{domain.mailboxCount === 1 ? '' : 'es'}</p>
        </div>
        <label className="flex items-center gap-2 text-[12px] whitespace-nowrap text-muted">
          Catch-all
          <Select
            value={domain.catchAllMailboxId ?? ''}
            className="h-7 w-52"
            onChange={(e) =>
              update.mutate(
                { id: domain.id, catchAllMailboxId: e.target.value || null },
                { onError: (err) => toast({ tone: 'error', title: 'Not saved', description: errorMessage(err) }) },
              )
            }
          >
            <option value="">Off: reject unknown</option>
            {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
          </Select>
        </label>
        <Button size="sm" variant="secondary" icon={<Stethoscope size={14} strokeWidth={1.75} />} onClick={() => setChecking((c) => !c)} aria-expanded={checking}>
          {checking ? 'Hide DNS check' : 'Check DNS'}
        </Button>
        <IconButton
          label={`Remove ${domain.name}`}
          size="sm"
          onClick={async () => {
            if (await confirm({ title: `Remove ${domain.name}?`, body: 'Mail to this domain will be rejected.', confirmLabel: 'Remove', danger: true }))
              remove.mutate(domain.id, { onError: (err) => toast({ tone: 'error', title: 'Not removed', description: errorMessage(err) }) });
          }}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
      {checking && <DomainCheckPanel domainId={domain.id} />}
    </li>
  );
}
