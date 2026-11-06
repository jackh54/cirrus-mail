import { AlertTriangle, Database, Globe, Inbox, Mail, Send, ShieldX, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageTitle, Section } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { errorMessage } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { useAdminStats } from '../../lib/queries/admin';
import { DailyChart } from './DailyChart';

function Stat({ icon, label, value, hint, tone }: { icon: ReactNode; label: string; value: string; hint?: string; tone?: 'danger' }) {
  return (
    <div className="bg-bg px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[12px] text-muted [&_svg]:stroke-[1.75]">
        <span className={tone === 'danger' ? 'text-danger' : 'text-faint'}>{icon}</span>
        {label}
      </div>
      <p className="tnum mt-1.5 text-[20px] leading-7 font-semibold tracking-[-0.015em]">{value}</p>
      {hint && <p className="text-[12px] text-faint">{hint}</p>}
    </div>
  );
}

const n = (x: number) => x.toLocaleString();

export function OverviewPage() {
  const stats = useAdminStats();
  return (
    <>
      <PageTitle title="Overview" description="Your Cirrus Mail instance at a glance." />
      {stats.isPending ? (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border sm:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <div key={i} className="bg-bg p-4"><Skeleton className="h-12" /></div>)}</div>
      ) : stats.isError ? (
        <p className="text-[13px] text-danger">{errorMessage(stats.error)}</p>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border sm:grid-cols-4">
            <Stat icon={<Users size={15} />} label="Users" value={n(stats.data.users)} />
            <Stat icon={<Inbox size={15} />} label="Mailboxes" value={n(stats.data.mailboxes)} />
            <Stat icon={<Globe size={15} />} label="Domains" value={n(stats.data.domains)} />
            <Stat icon={<Database size={15} />} label="Storage" value={formatBytes(stats.data.storageBytes)} hint={`${n(stats.data.messages)} messages`} />
            <Stat icon={<Send size={15} />} label="Sent today" value={n(stats.data.sentToday)} hint="Daily quota grows over time" />
            <Stat icon={<Send size={15} />} label="Sent, 30 days" value={n(stats.data.sent30d)} hint="3,000/month included" />
            <Stat icon={<Mail size={15} />} label="Received, 30 days" value={n(stats.data.received30d)} />
            <Stat icon={<ShieldX size={15} />} label="Rejected, 30 days" value={n(stats.data.rejected30d)} />
          </div>
          {stats.data.sendErrors30d > 0 && (
            <div className="mb-8 flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-[13px] text-warning">
              <AlertTriangle size={15} /> {n(stats.data.sendErrors30d)} send errors in the last 30 days. Check quota and Email Sending onboarding.
            </div>
          )}
          <Section title="Last 14 days" description="Messages sent and received per day.">
            <DailyChart data={stats.data.daily} />
          </Section>
        </>
      )}
    </>
  );
}
