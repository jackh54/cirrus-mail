import { useState } from 'react';
import { Check, Copy, Download, ShieldCheck } from 'lucide-react';
import type { TotpBeginResponse } from '@shared/api';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { Section } from '../../components/PageShell';
import { QrCode } from '../../components/QrCode';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { useMeData, useTotpBegin, useTotpDisable, useTotpEnable } from '../../lib/queries/me';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={done ? <Check size={13} /> : <Copy size={13} />}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export function TotpSection() {
  const { user } = useMeData();
  const begin = useTotpBegin();
  const enable = useTotpEnable();
  const disable = useTotpDisable();
  const { toast } = useToast();
  const [setup, setSetup] = useState<TotpBeginResponse | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const start = () =>
    begin.mutate(undefined, {
      onSuccess: (r) => {
        setSetup(r);
        setCode('');
        setError(null);
      },
      onError: (e) => toast({ tone: 'error', title: 'Could not start setup', description: errorMessage(e) }),
    });

  const verify = () =>
    enable.mutate(code.replace(/\s/g, ''), {
      onSuccess: (r) => {
        setSetup(null);
        setCodes(r.recoveryCodes);
      },
      onError: (e) => setError(errorMessage(e)),
    });

  return (
    <Section
      title="Two-factor authentication"
      description="Require a code from an authenticator app (1Password, Google Authenticator, Authy…) when signing in."
      footer={
        user.totpEnabled ? (
          <Button variant="ghost" className="text-danger" onClick={() => setDisabling(true)}>Turn off</Button>
        ) : (
          <Button variant="primary" loading={begin.isPending} onClick={start}>Set up</Button>
        )
      }
    >
      <p className="flex items-center gap-2 text-sm">
        <ShieldCheck size={16} className={user.totpEnabled ? 'text-success' : 'text-faint'} />
        {user.totpEnabled ? 'On. You will be asked for a code each time you sign in.' : 'Off.'}
      </p>

      <Dialog open={!!setup} onClose={() => setSetup(null)} title="Set up two-factor authentication" width={520}
        footer={<><Button variant="ghost" onClick={() => setSetup(null)}>Cancel</Button><Button variant="primary" loading={enable.isPending} disabled={code.replace(/\s/g, '').length < 6} onClick={verify}>Verify and turn on</Button></>}
      >
        {setup && (
          <div className="space-y-4">
            <p className="text-sm text-muted">1. Scan this code with your authenticator app.</p>
            <div className="flex flex-col items-center gap-3 rounded-xl bg-surface-2 p-4 sm:flex-row sm:items-start">
              <QrCode value={setup.otpauthUrl} label="QR code for your authenticator app" />
              <div className="min-w-0 space-y-2 text-center sm:text-left">
                <p className="text-[13px] text-muted">Can't scan? Enter this key manually:</p>
                <p className="font-mono text-[15px] font-medium tracking-wider break-all text-fg">{setup.secret.match(/.{1,4}/g)?.join(' ')}</p>
                <div className="flex flex-wrap justify-center gap-1 sm:justify-start">
                  <CopyButton text={setup.secret} label="Copy key" />
                  <CopyButton text={setup.otpauthUrl} label="Copy link" />
                </div>
              </div>
            </div>
            <Field label="2. Enter the 6-digit code it shows" error={error}>
              {(id, d) => (
                <Input id={id} aria-describedby={d} aria-invalid={!!error} inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} className="max-w-40 font-mono tracking-[0.25em]" placeholder="123456" />
              )}
            </Field>
          </div>
        )}
      </Dialog>

      <Dialog open={!!codes} onClose={() => setCodes(null)} title="Save your recovery codes" description="Each code works once if you lose your phone. Store them somewhere safe; they won't be shown again."
        footer={<Button variant="primary" onClick={() => setCodes(null)}>I've saved them</Button>}
      >
        {codes && (
          <>
            <ul className="grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-4 font-mono text-sm">
              {codes.map((c) => <li key={c}>{c}</li>)}
            </ul>
            <div className="mt-3 flex gap-1">
              <CopyButton text={codes.join('\n')} label="Copy all" />
              <Button
                size="sm"
                variant="ghost"
                icon={<Download size={13} />}
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([`Cirrus Mail recovery codes for ${user.email}\n\n${codes.join('\n')}\n`], { type: 'text/plain' }));
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'cirrus-recovery-codes.txt';
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download
              </Button>
            </div>
          </>
        )}
      </Dialog>

      <Dialog open={disabling} onClose={() => setDisabling(false)} title="Turn off two-factor authentication?" width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDisabling(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={disable.isPending}
              disabled={!password}
              onClick={() =>
                disable.mutate(password, {
                  onSuccess: () => {
                    setDisabling(false);
                    setPassword('');
                    toast({ title: 'Two-factor authentication is off' });
                  },
                  onError: (e) => toast({ tone: 'error', title: 'Not turned off', description: errorMessage(e) }),
                })
              }
            >
              Turn off
            </Button>
          </>
        }
      >
        <Field label="Confirm with your password">
          {(id) => <Input id={id} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
      </Dialog>
    </Section>
  );
}
