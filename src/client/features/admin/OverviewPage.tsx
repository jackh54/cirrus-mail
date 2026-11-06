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
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-[12.5px] text-muted">
        <span className={tone === 'danger' ? 'text-danger' : 'text-primary'}>{icon}</span>
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      ) : stats.isError ? (
        <p className="text-sm text-danger">{errorMessage(stats.error)}</p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat icon={<Users size={15} />} label="Users" value={n(stats.data.users)} />
            <Stat icon={<Inbox size={15} />} label="Mailboxes" value={n(stats.data.mailboxes)} />
            <Stat icon={<Globe size={15} />} label="Domains" value={n(stats.data.domains)} />
            <Stat icon={<Database size={15} />} label="Storage" value={formatBytes(stats.data.storageBytes)} hint={`${n(stats.data.messages)} messages`} />
            <Stat icon={<Send size={15} />} label="Sent today" value={n(stats.data.sentToday)} hint="Daily quota grows over time" />
            <Stat icon={<Send size={15} />} label="Sent · 30 days" value={n(stats.data.sent30d)} hint="3,000/month included" />
            <Stat icon={<Mail size={15} />} label="Received · 30 days" value={n(stats.data.received30d)} />
            <Stat icon={<ShieldX size={15} />} label="Rejected · 30 days" value={n(stats.data.rejected30d)} />
          </div>
          {stats.data.sendErrors30d > 0 && (
            <div className="mb-6 flex items-center gap-2 rounded-xl bg-warning-soft px-4 py-3 text-[13px] text-warning">
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
