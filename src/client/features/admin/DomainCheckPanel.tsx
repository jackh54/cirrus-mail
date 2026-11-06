import { CheckCircle2, CircleHelp, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '../../components/Button';
import { Skeleton } from '../../components/Skeleton';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/api';
import { useDomainCheck } from '../../lib/queries/admin';

function Row({ ok, title, detail, fix }: { ok: boolean | null; title: string; detail: string; fix?: string }) {
  const Icon = ok === null ? CircleHelp : ok ? CheckCircle2 : XCircle;
  return (
    <li className={cn('flex gap-3 rounded-lg px-3 py-2.5', ok === false ? 'bg-danger-soft' : ok ? 'bg-success-soft' : 'bg-surface-2')}>
      <Icon size={17} className={cn('mt-0.5 shrink-0', ok === false ? 'text-danger' : ok ? 'text-success' : 'text-faint')} />
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium text-fg">{title}</p>
        <p className="font-mono text-[12px] break-all text-muted">{detail}</p>
        {!ok && fix && <p className="mt-1 text-[12.5px] text-fg">{fix}</p>}
      </div>
    </li>
  );
}

export function DomainCheckPanel({ domainId }: { domainId: string }) {
  const check = useDomainCheck(domainId);
  return (
    <div className="border-t border-border bg-bg/50 px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[13px] font-medium">DNS health</p>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} className={check.isFetching ? 'animate-spin' : undefined} />} onClick={() => void check.refetch()}>
          Re-check
        </Button>
      </div>
      {check.isPending ? (
        <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
      ) : check.isError ? (
        <p className="text-sm text-danger">{errorMessage(check.error)}</p>
      ) : (
        <ul className="space-y-2">
          <Row
            ok={check.data.mx.ok}
            title="MX records point to Cloudflare Email Routing"
            detail={check.data.mx.records.join(', ') || 'No MX records found'}
            fix="Enable Email Routing for this domain in the Cloudflare dashboard; it adds the MX records for you."
          />
          <Row
            ok={check.data.spf.ok}
            title="SPF includes Cloudflare"
            detail={check.data.spf.record ?? 'No SPF record'}
            fix='Add or update the TXT record: v=spf1 include:_spf.mx.cloudflare.net ~all'
          />
          <Row
            ok={check.data.dmarc.ok}
            title="DMARC policy present"
            detail={check.data.dmarc.record ?? 'No _dmarc record'}
            fix='Add a TXT record at _dmarc with at least: v=DMARC1; p=none; rua=mailto:you@yourdomain'
          />
          <Row ok={check.data.dkim.ok} title="DKIM" detail={check.data.dkim.note} />
        </ul>
      )}
    </div>
  );
}
