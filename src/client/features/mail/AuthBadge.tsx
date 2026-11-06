import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { AuthResults } from '@shared/api';
import { Tooltip } from '../../components/Tooltip';

function row(label: string, v?: string) {
  return `${label} ${v ?? 'none'}`;
}

/** Shield showing SPF/DKIM/DMARC; warns when DMARC fails. */
export function AuthBadge({ auth }: { auth: AuthResults | null }) {
  if (!auth) return null;
  const summary = [row('SPF', auth.spf), row('DKIM', auth.dkim), row('DMARC', auth.dmarc)].join(' · ');
  if (auth.dmarc === 'fail') {
    return (
      <Tooltip label="Sender authentication failed" content={<><strong className="font-semibold">DMARC failed.</strong> This sender may be forged. Be careful with links and attachments.<br /><span className="opacity-70">{summary}</span></>}>
        <ShieldAlert size={15} className="text-warning" />
      </Tooltip>
    );
  }
  if (auth.dmarc === 'pass' || (auth.spf === 'pass' && auth.dkim === 'pass')) {
    return (
      <Tooltip label="Sender verified" content={<>Verified sender<br /><span className="opacity-70">{summary}</span></>}>
        <ShieldCheck size={15} className="text-success" />
      </Tooltip>
    );
  }
  return (
    <Tooltip label="Sender not verified" content={<>Sender could not be verified<br /><span className="opacity-70">{summary}</span></>}>
      <ShieldQuestion size={15} className="text-faint" />
    </Tooltip>
  );
}
