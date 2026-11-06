import { useState, type FormEvent } from 'react';
import { Laptop, Smartphone } from 'lucide-react';
import { Button } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Field, Input } from '../../components/Field';
import { PageTitle, Section } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { relativeAgo } from '../../lib/format';
import { useChangePassword, useRevokeSession, useSessions } from '../../lib/queries/me';
import { TotpSection } from './TotpSection';

export function SecuritySettings() {
  return (
    <>
      <PageTitle title="Security" description="Password, two-factor authentication and signed-in devices." />
      <PasswordSection />
      <TotpSection />
      <SessionsSection />
    </>
  );
}

function PasswordSection() {
  const change = useChangePassword();
  const { toast } = useToast();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (f.next.length < 10) return setError('Use at least 10 characters.');
    if (f.next !== f.confirm) return setError('The new passwords do not match.');
    change.mutate(
      { current: f.current, next: f.next },
      {
        onSuccess: () => {
          setF({ current: '', next: '', confirm: '' });
          toast({ tone: 'success', title: 'Password changed' });
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <Section
        title="Password"
        footer={<Button type="submit" variant="primary" loading={change.isPending} disabled={!f.current || !f.next}>Change password</Button>}
      >
        {error && <p role="alert" className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Current password">
            {(id) => <Input id={id} type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />}
          </Field>
          <Field label="New password">
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />}
          </Field>
          <Field label="Confirm new password">
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />}
          </Field>
        </div>
      </Section>
    </form>
  );
}

function deviceLabel(ua: string | null): { name: string; mobile: boolean } {
  if (!ua) return { name: 'Unknown device', mobile: false };
  const mobile = /iPhone|Android|Mobile/i.test(ua);
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return { name: os ? `${browser} on ${os}` : browser, mobile };
}

function SessionsSection() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const confirm = useConfirm();
  const { toast } = useToast();

  return (
    <Section title="Signed-in devices" description="Sign out anywhere you no longer use. Sessions expire after 30 days without activity.">
      {sessions.isPending ? (
        <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      ) : sessions.isError ? (
        <p className="text-sm text-danger">{errorMessage(sessions.error)}</p>
      ) : (
        <ul className="divide-y divide-border">
          {sessions.data.map((s) => {
            const d = deviceLabel(s.userAgent);
            return (
              <li key={s.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <span className="flex size-9 items-center justify-center rounded-lg bg-surface-2 text-muted">
                  {d.mobile ? <Smartphone size={16} /> : <Laptop size={16} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {d.name}
                    {s.current && <span className="ml-2 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-semibold text-success">This device</span>}
                  </p>
                  <p className="text-[12.5px] text-muted">Active {relativeAgo(s.lastSeenAt)} · signed in {relativeAgo(s.createdAt)}</p>
                </div>
                {!s.current && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={async () => {
                      if (!(await confirm({ title: 'Sign out this device?', confirmLabel: 'Sign out', danger: true }))) return;
                      revoke.mutate(s.id, { onError: (e) => toast({ tone: 'error', title: 'Could not sign out', description: errorMessage(e) }) });
                    }}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
