import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { ArrowRight, AtSign, CheckCircle2, Globe, Inbox, Route as RouteIcon } from 'lucide-react';
import { Button, LinkButton } from '../../components/Button';
import { Field, Input } from '../../components/Field';
import { FullScreenSpinner } from '../../components/Spinner';
import { errorMessage, isApiError } from '../../lib/api';
import { useSetup, useSetupStatus } from '../../lib/queries/me';
import { AuthLayout, FormError } from './AuthLayout';

export function SetupPage() {
  const status = useSetupStatus();
  const setup = useSetup();
  const [done, setDone] = useState(false);
  const [form, setForm] = useState({ token: '', name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);

  if (status.isPending) return <FullScreenSpinner />;
  if (!done && status.data && !status.data.needsSetup) return <Navigate to="/login" replace />;
  if (done) return <NextSteps />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const tooShort = form.password.length > 0 && form.password.length < 10;
  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.password.length < 10) return setError('Use at least 10 characters for the password.');
    if (form.password !== form.confirm) return setError('The passwords do not match.');
    setup.mutate(
      { token: form.token.trim(), name: form.name.trim(), email: form.email.trim(), password: form.password },
      {
        onSuccess: () => setDone(true),
        onError: (err) =>
          setError(isApiError(err) && err.status === 403 ? 'That setup token does not match the SETUP_TOKEN secret.' : errorMessage(err)),
      },
    );
  };

  return (
    <AuthLayout title="Welcome to Cirrus Mail" subtitle="Create the first administrator account." wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Setup token" hint="The SETUP_TOKEN secret you set when deploying the Worker.">
          {(id, d) => <Input id={id} aria-describedby={d} autoFocus required autoComplete="off" className="font-mono" value={form.token} onChange={set('token')} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            {(id) => <Input id={id} required autoComplete="name" value={form.name} onChange={set('name')} />}
          </Field>
          <Field label="Sign-in email" hint="Can be any address you own.">
            {(id, d) => <Input id={id} aria-describedby={d} type="email" required autoComplete="username" value={form.email} onChange={set('email')} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Password" error={tooShort ? 'At least 10 characters' : null}>
            {(id, d) => (
              <Input id={id} aria-describedby={d} aria-invalid={tooShort} type="password" required autoComplete="new-password" value={form.password} onChange={set('password')} />
            )}
          </Field>
          <Field label="Confirm password" error={mismatch ? 'Does not match' : null}>
            {(id, d) => (
              <Input id={id} aria-describedby={d} aria-invalid={mismatch} type="password" required autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />
            )}
          </Field>
        </div>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={setup.isPending}>
          Create admin account
        </Button>
      </form>
    </AuthLayout>
  );
}

const STEPS = [
  {
    icon: Globe,
    title: 'Add your domain',
    body: 'The domain must already be on your Cloudflare account. Cirrus checks its MX, SPF and DMARC records for you.',
    to: '/admin/domains',
    cta: 'Add a domain',
  },
  {
    icon: Inbox,
    title: 'Create a mailbox',
    body: 'Create you@yourdomain and add yourself as the owner. Shared mailboxes can have several members.',
    to: '/admin/mailboxes',
    cta: 'Create a mailbox',
  },
  {
    icon: RouteIcon,
    title: 'Route all mail to the Worker',
    body: 'In the Cloudflare dashboard open Compute & AI → Email Service → Email Routing → Routing rules, edit the catch-all address, and choose "Send to a Worker" → cirrus-mail.',
    to: '/admin/domains#guide',
    cta: 'Show the guide',
  },
  {
    icon: AtSign,
    title: 'Enable Email Sending',
    body: 'Onboard the domain in Email Service → Email Sending so the Worker can deliver outbound mail.',
    to: '/admin/domains#guide',
    cta: 'Show the guide',
  },
];

function NextSteps() {
  return (
    <AuthLayout title="You're in" subtitle="Four steps and your domain is receiving mail." wide>
      <div className="mb-5 flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2 text-[13px] text-success">
        <CheckCircle2 size={16} /> Admin account created and signed in.
      </div>
      <ol className="space-y-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3 rounded-xl border border-border p-3.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
              <s.icon size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                <span className="text-faint">{i + 1}.</span> {s.title}
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{s.body}</p>
              <Link to={s.to} className="mt-1.5 inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
                {s.cta} <ArrowRight size={13} />
              </Link>
            </div>
          </li>
        ))}
      </ol>
      <LinkButton to="/admin" variant="primary" size="lg" className="mt-5 w-full">
        Open the admin console
      </LinkButton>
    </AuthLayout>
  );
}
