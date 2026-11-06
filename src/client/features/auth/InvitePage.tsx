import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Field, Input } from '../../components/Field';
import { Button } from '../../components/Button';
import { FullScreenSpinner } from '../../components/Spinner';
import { isApiError } from '../../lib/api';
import { useInviteAccept, useInviteLookup } from '../../lib/queries/me';
import { AuthLayout, FormError } from './AuthLayout';

const MIN_PASSWORD = 8; // matches zPassword in src/worker/lib/validate.ts

export function InvitePage() {
  const lookup = useInviteLookup();
  const accept = useInviteAccept();
  const navigate = useNavigate();
  const token = useRef<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    // Read the token once, then take it out of the address bar and history entry. Lookup is run only once even under StrictMode.
    if (token.current !== null) return;
    token.current = location.hash.replace(/^#/, '');
    history.replaceState(null, '', location.pathname + location.search);
    // No token (opened without one, or reloaded after it was stripped): nothing to check.
    if (!token.current) setMissing(true);
    else lookup.mutate(token.current, { onSuccess: (r) => setName(r.name) });
  }, []);

  if (lookup.isError || missing) {
    return (
      <AuthLayout title="Invite link not valid">
        <div className="space-y-4">
          <p className="text-center text-[13px] text-muted">
            {lookup.isError && !(isApiError(lookup.error) && lookup.error.code === 'INVITE_INVALID')
              ? 'We could not check this invite. Try the link again in a moment.'
              : 'This invite link has expired or was already used. Ask whoever invited you for a new one.'}
          </p>
          <Link to="/login" className="mx-auto flex h-7 w-fit items-center rounded-md px-2 text-[13px] text-primary hover:bg-hover">Go to sign in</Link>
        </div>
      </AuthLayout>
    );
  }
  if (!lookup.data) return <FullScreenSpinner />;
  const invite = lookup.data;

  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = name.trim() && password.length >= MIN_PASSWORD && confirm === password;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || token.current === null) return;
    setError(null);
    accept.mutate(
      { token: token.current, name: name.trim(), password },
      {
        onSuccess: () => navigate('/', { replace: true }),
        onError: (err) => {
          if (isApiError(err) && err.code === 'INVITE_INVALID') setError('This invite link has expired or was already used. Ask whoever invited you for a new one.');
          else setError(isApiError(err) ? err.message : 'Could not create your account.');
        },
      },
    );
  };

  return (
    <AuthLayout title="Join Cirrus" subtitle={invite.inviterName ? `${invite.inviterName} invited you.` : undefined}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <dl className="space-y-1 rounded-md bg-surface-2 px-3 py-2 text-[13px]">
          <div className="flex justify-between gap-3"><dt className="text-muted">Sign-in email</dt><dd className="min-w-0 truncate">{invite.email}</dd></div>
          {invite.mailboxAddress && <div className="flex justify-between gap-3"><dt className="text-muted">Mailbox</dt><dd className="min-w-0 truncate">{invite.mailboxAddress}</dd></div>}
        </dl>
        <Field label="Name">{(id) => <Input id={id} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Password" hint={`At least ${MIN_PASSWORD} characters.`}>
          {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" required autoFocus minLength={MIN_PASSWORD} value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Field label="Confirm password" error={mismatch ? 'Passwords do not match.' : null}>
          {(id, d) => <Input id={id} aria-describedby={d} aria-invalid={mismatch || undefined} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" size="lg" className="mt-1 w-full" disabled={!valid} loading={accept.isPending}>Create account</Button>
      </form>
    </AuthLayout>
  );
}
