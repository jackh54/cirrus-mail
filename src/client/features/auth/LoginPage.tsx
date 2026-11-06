import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { Button } from '../../components/Button';
import { Field, Input } from '../../components/Field';
import { FullScreenSpinner } from '../../components/Spinner';
import { isApiError } from '../../lib/api';
import { useLogin, useSetupStatus } from '../../lib/queries/me';
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

  useEffect(() => {
    if (step === 'totp') totpRef.current?.focus();
  }, [step]);

  if (setup.isPending) return <FullScreenSpinner />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
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

  return (
    <AuthLayout
      title={step === 'password' ? 'Sign in to Cirrus Mail' : 'Two-factor authentication'}
      subtitle={step === 'totp' ? 'Enter the 6-digit code from your authenticator app, or a recovery code.' : undefined}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        {step === 'password' ? (
          <>
            <Field label="Email">
              {(id) => (
                <Input id={id} type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
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
                className="text-center font-mono text-lg tracking-[0.3em]"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
              />
            )}
          </Field>
        )}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={login.isPending} icon={step === 'totp' ? <KeyRound size={16} /> : undefined}>
          {step === 'password' ? 'Sign in' : 'Verify'}
        </Button>
        {step === 'totp' && (
          <button
            type="button"
            onClick={() => {
              setStep('password');
              setTotp('');
              setError(null);
            }}
            className="mx-auto flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"
          >
            <ArrowLeft size={14} /> Use a different account
          </button>
        )}
      </form>
    </AuthLayout>
  );
}
