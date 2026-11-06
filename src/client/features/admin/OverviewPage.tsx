import { AlertTriangle, Database, Globe, Inbox, Mail, Send, ShieldX, Sparkles, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { SEND_WARN_RATIO } from '@shared/api';
import { Button } from '../../components/Button';
import { Field, Input, Switch } from '../../components/Field';
import { PageTitle, Section } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { useAdminStats } from '../../lib/queries/admin';
import { useAdminAi, useUpdateAdminAi } from '../../lib/queries/ai';
import { useAdminSettings, useUpdateAdminSettings } from '../../lib/queries/sending';
import { DailyChart } from './DailyChart';

function Stat({ icon, label, value, hint, tone, bar }: { icon: ReactNode; label: string; value: string; hint?: string; tone?: 'danger'; bar?: { value: number; max: number } }) {
  return (
    <div className="bg-bg px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[12px] text-muted [&_svg]:stroke-[1.75]">
        <span className={tone === 'danger' ? 'text-danger' : 'text-faint'}>{icon}</span>
        {label}
      </div>
      <p className="tnum mt-1.5 text-[20px] leading-7 font-semibold tracking-[-0.015em]">{value}</p>
      {bar && <UsageBar label={label} {...bar} />}
      {hint && <p className="text-[12px] text-faint">{hint}</p>}
    </div>
  );
}

/** Thin usage bar: primary, amber from SEND_WARN_RATIO, danger once the limit is reached. */
function UsageBar({ label, value, max }: { label: string; value: number; max: number }) {
  const ratio = value / max;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuenow={Math.min(value, max)}
      aria-valuemax={max}
      className="mt-1.5 mb-1 h-1 overflow-hidden rounded-full bg-hover"
    >
      <div
        className={ratio >= 1 ? 'h-full bg-danger' : ratio >= SEND_WARN_RATIO ? 'h-full bg-warning' : 'h-full bg-primary'}
        style={{ width: `${Math.min(100, ratio * 100)}%` }}
      />
    </div>
  );
}

/** Cloudflare doesn't expose the account's quota, so an admin types it in and Cirrus only warns. */
function SendingSettings() {
  const settings = useAdminSettings();
  const save = useUpdateAdminSettings();
  const { toast } = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const saved = settings.data?.dailySendLimit;
  const value = draft ?? (saved == null ? '' : String(saved));
  const parsed = value.trim() === '' ? null : Number(value);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1 && parsed <= 1_000_000);
  const dirty = draft !== null && parsed !== (saved ?? null);

  const submit = () => {
    if (!valid || !dirty) return;
    save.mutate(
      { dailySendLimit: parsed },
      {
        onSuccess: () => {
          setDraft(null);
          toast({ tone: 'success', title: parsed === null ? 'Daily limit cleared' : 'Daily limit saved', duration: 2500 });
        },
        onError: (e) => toast({ tone: 'error', title: 'Not saved', description: errorMessage(e) }),
      },
    );
  };

  return (
    <Section title="Sending" description="Counts are for today (UTC) and reset at 00:00 UTC.">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field
          label="Daily sending limit"
          className="min-w-0 flex-1 sm:max-w-xs sm:flex-none"
          error={valid ? null : 'Enter a whole number from 1 to 1,000,000, or leave it empty.'}
        >
          {(id, d) => (
            <Input
              id={id}
              aria-describedby={d ? `${d} sending-limit-help` : 'sending-limit-help'}
              type="number"
              inputMode="numeric"
              min={1}
              max={1_000_000}
              step={1}
              placeholder="Not set"
              disabled={settings.isPending}
              value={value}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={!valid || !dirty} loading={save.isPending}>Save</Button>
      </form>
      <p id="sending-limit-help" className="mt-1.5 text-[12px] leading-4 text-muted">
        Cloudflare sets this per account and raises it as you send good mail. Find it under Email Service → Email Sending in the dashboard. Cirrus uses it only to warn you; it never blocks a send.
      </p>
    </Section>
  );
}

/** Optional AI triage. Off by default: message text goes to Workers AI on this account, billed per use by Cloudflare. */
function AiSettings() {
  const ai = useAdminAi();
  const save = useUpdateAdminAi();
  const { toast } = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const saved = ai.data?.dailyBudget;
  const value = draft ?? (saved == null ? '' : String(saved));
  const parsed = value.trim() === '' ? NaN : Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000;
  const dirty = draft !== null && parsed !== saved;
  const onError = (e: unknown) => toast({ tone: 'error', title: 'Not saved', description: errorMessage(e) });

  return (
    <Section title="AI" description="Sorts the Inbox into tabs and summarises long conversations. Off by default.">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[13px] font-medium">Turn on AI triage</p>
          <p className="text-[12px] leading-4 text-muted">
            When on, the text of new mail and of conversations people choose to summarise is sent to Workers AI on this same Cloudflare account, and Cloudflare bills it per use. Nothing goes to any other service.
          </p>
        </div>
        <Switch checked={!!ai.data?.enabled} label="Turn on AI triage" disabled={ai.isPending || save.isPending} onChange={(enabled) => save.mutate({ enabled }, { onError })} />
      </div>
      {ai.data && !ai.data.available && (
        <p className="mt-2 text-[12px] text-warning">This deployment has no AI binding, so nothing will run. Add the Workers AI binding to wrangler.jsonc and deploy.</p>
      )}
      <form
        className="mt-5 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || !dirty) return;
          save.mutate({ dailyBudget: parsed }, { onSuccess: () => { setDraft(null); toast({ tone: 'success', title: 'AI budget saved', duration: 2500 }); }, onError });
        }}
      >
        <Field label="Daily AI calls" className="min-w-0 flex-1 sm:max-w-xs sm:flex-none" error={valid ? null : 'Enter a whole number from 0 to 100,000.'}>
          {(id, d) => (
            <Input id={id} aria-describedby={d ? `${d} ai-budget-help` : 'ai-budget-help'} type="number" inputMode="numeric" min={0} max={100_000} step={1} disabled={ai.isPending} value={value} onChange={(e) => setDraft(e.target.value)} />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={!valid || !dirty} loading={save.isPending}>Save</Button>
      </form>
      {ai.data && (
        <div className="mt-3 max-w-xs">
          <p className="tnum flex items-center gap-1.5 text-[13px]"><Sparkles size={14} strokeWidth={1.75} className="text-faint" /> {ai.data.usedToday.toLocaleString()} / {ai.data.dailyBudget.toLocaleString()} calls used today (UTC)</p>
          {ai.data.dailyBudget > 0 && <UsageBar label="AI calls today" value={ai.data.usedToday} max={ai.data.dailyBudget} />}
        </div>
      )}
      <p id="ai-budget-help" className="mt-1.5 text-[12px] leading-4 text-muted">
        Caps AI calls per UTC day, one per message sorted or summary written. Over the cap, sorting stops quietly and Summarise says the limit was reached. Obvious mail (newsletters, notifications) is sorted without AI and costs nothing.
      </p>
    </Section>
  );
}

const n = (x: number) => x.toLocaleString();

export function OverviewPage() {
  const stats = useAdminStats();
  const limit = stats.data?.dailySendLimit;
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
            <Stat
              icon={<Send size={15} />}
              label="Sent today (UTC)"
              value={limit ? `${n(stats.data.sentToday)} / ${n(limit)}` : n(stats.data.sentToday)}
              bar={limit ? { value: stats.data.sentToday, max: limit } : undefined}
              hint={limit ? undefined : 'Set your daily limit'}
            />
            <Stat icon={<Send size={15} />} label="Sent, 30 days" value={n(stats.data.sent30d)} hint="3,000/mo included, then $0.35/1k" />
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
          <SendingSettings />
          <AiSettings />
        </>
      )}
    </>
  );
}
