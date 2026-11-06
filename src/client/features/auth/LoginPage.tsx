import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, Fingerprint, KeyRound } from 'lucide-react';
import { Button } from '../../components/Button';
import { Field, Input } from '../../components/Field';
import { FullScreenSpinner } from '../../components/Spinner';
import { isApiError } from '../../lib/api';
import { useLogin, useSetupStatus } from '../../lib/queries/me';
import { requestPasskeyAssertion, usePasskeyLogin } from '../../lib/queries/passkeys';
import { conditionalUiSupported, isPasskeyCancel, passkeysSupported } from '../../lib/webauthn';
import { AuthLayout, FormError } from './AuthLayout';

function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginPage() {
  const setup = useSetupStatus();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const totpRef = useRef<HTMLInputElement>(null);
  const autofill = usePasskeyLogin();
  const passkey = usePasskeyLogin();
  const autofillCtl = useRef<AbortController | null>(null);
  const hasPasskeys = passkeysSupported();
  const ready = !!setup.data && !setup.data.needsSetup;

  const done = () => navigate(safeNext(params.get('next')), { replace: true });
  const passkeyError = (err: unknown) => {
    if (isPasskeyCancel(err)) return;
    if (isApiError(err) && err.status === 429) setError('Too many attempts. Wait 15 minutes and try again.');
    else if (isApiError(err) && err.code === 'ACCOUNT_DISABLED') setError(err.message);
    else setError('Passkey sign-in failed. Try again, or use your password.');
  };

  // Conditional UI: the browser offers saved passkeys in the email field's autofill list.
  useEffect(() => {
    if (!ready || step !== 'password') return;
    const ctl = new AbortController();
    autofillCtl.current = ctl;
    void conditionalUiSupported().then((ok) => {
      if (ok && !ctl.signal.aborted) autofill.mutate({ conditional: true, signal: ctl.signal }, { onSuccess: done, onError: passkeyError });
    });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, step]);

  useEffect(() => {
    if (step === 'totp') totpRef.current?.focus();
  }, [step]);

  if (setup.isPending) return <FullScreenSpinner />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    autofillCtl.current?.abort();
    login.mutate(
      { email: email.trim(), password, totp: step === 'totp' ? totp.replace(/\s/g, '') : undefined },
      {
        onSuccess: () => navigate(safeNext(params.get('next')), { replace: true }),
        onError: (err) => {
          if (isApiError(err) && err.code === 'TOTP_REQUIRED') {
            if (step === 'totp') setError('That code is not valid. Try the current one from your app.');
            setStep('totp');
          } else if (isApiError(err) && err.status === 429) {
            setError('Too many attempts. Wait 15 minutes and try again.');
          } else if (isApiError(err) && err.code === 'INVALID_CREDENTIALS') {
            setError(step === 'totp' ? 'That code is not valid.' : 'Email or password is incorrect.');
          } else {
            setError(isApiError(err) ? err.message : 'Sign in failed.');
          }
        },
      },
    );
  };

  const signInWithPasskey = () => {
    setError(null);
    autofillCtl.current?.abort();
    passkey.mutate({}, { onSuccess: done, onError: passkeyError });
  };

  // A passkey can stand in for the authentication code once the password has been accepted.
  const passkeyAsSecondFactor = async () => {
    setError(null);
    try {
      const assertion = await requestPasskeyAssertion({ mfa: true });
      login.mutate({ email: email.trim(), password, passkey: assertion }, { onSuccess: done, onError: passkeyError });
    } catch (err) {
      passkeyError(err);
    }
  };

  return (
    <AuthLayout
      title={step === 'password' ? 'Sign in to Cirrus' : 'Two-factor authentication'}
      subtitle={step === 'totp' ? 'Enter the 6-digit code from your authenticator app, or a recovery code.' : undefined}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        {step === 'password' ? (
          <>
            <Field label="Email">
              {(id) => (
                <Input id={id} type="email" autoComplete="username webauthn" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              )}
            </Field>
            <Field label="Password">
              {(id) => (
                <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              )}
            </Field>
          </>
        ) : (
          <Field label="Authentication code">
            {(id) => (
              <Input
                id={id}
                ref={totpRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123 456"
                className="tnum h-10 text-center text-[17px] tracking-[0.2em]"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
              />
            )}
          </Field>
        )}
        <Button type="submit" variant="primary" size="lg" className="mt-1 w-full" loading={login.isPending} icon={step === 'totp' ? <KeyRound size={15} /> : undefined}>
          {step === 'password' ? 'Sign in' : 'Verify'}
        </Button>
        {hasPasskeys && (
          <Button type="button" variant="secondary" size="lg" className="w-full" loading={passkey.isPending} icon={<Fingerprint size={15} />} onClick={step === 'totp' ? passkeyAsSecondFactor : signInWithPasskey}>
            {step === 'totp' ? 'Use a passkey instead' : 'Sign in with a passkey'}
          </Button>
        )}
        {step === 'totp' && (
          <button
            type="button"
            onClick={() => {
              setStep('password');
              setTotp('');
              setError(null);
            }}
            className="mx-auto flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted hover:bg-hover hover:text-fg"
          >
            <ArrowLeft size={14} strokeWidth={1.75} /> Use a different account
          </button>
        )}
      </form>
    </AuthLayout>
  );
}
