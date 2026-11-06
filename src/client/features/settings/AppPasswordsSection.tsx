import { useState } from 'react';
import { Download, KeyRound } from 'lucide-react';
import { Button } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { Section } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { relativeAgo } from '../../lib/format';
import { useAppPasswords, useCreateAppPassword, useRevokeAppPassword } from '../../lib/queries/appPasswords';
import { useMeData } from '../../lib/queries/me';
import { buildMobileconfig } from './mobileconfig';
import { CopyButton } from './TotpSection';

export function AppPasswordsSection() {
  const list = useAppPasswords();
  const create = useCreateAppPassword();
  const revoke = useRevokeAppPassword();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const close = () => {
    setCreating(false);
    setName('');
    setPassword('');
    setError(null);
  };

  return (
    <Section
      title="App passwords"
      description="Let a phone or calendar app sign in without your account password. They keep working with two-factor authentication on."
      footer={<Button variant="primary" onClick={() => setCreating(true)}>Create app password</Button>}
    >
      {list.isPending ? (
        <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      ) : list.isError ? (
        <p className="text-[13px] text-danger">{errorMessage(list.error)}</p>
      ) : list.data.length === 0 ? (
        <p className="text-[13px] text-muted">No app passwords yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {list.data.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="flex size-8 items-center justify-center rounded-md bg-surface-2 text-muted [&_svg]:stroke-[1.75]"><KeyRound size={16} /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{p.name}</p>
                <p className="text-[12px] text-muted">
                  Created {relativeAgo(p.createdAt)}, {p.lastUsedAt ? `last used ${relativeAgo(p.lastUsedAt)}` : 'never used'}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                onClick={async () => {
                  if (!(await confirm({ title: `Revoke "${p.name}"?`, body: 'Anything using it stops syncing right away.', confirmLabel: 'Revoke', danger: true }))) return;
                  revoke.mutate(p.id, { onError: (e) => toast({ tone: 'error', title: 'Could not revoke', description: errorMessage(e) }) });
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={creating} onClose={close} title="Create app password" width={440}
        footer={
          <>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!name.trim() || !password}
              onClick={() =>
                create.mutate({ name: name.trim(), password }, {
                  onSuccess: (r) => {
                    close();
                    setSecret(r.secret);
                  },
                  onError: (e) => setError(errorMessage(e)),
                })
              }
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" hint="For example: iPhone contacts">
            {(id) => <Input id={id} autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Confirm with your password" error={error}>
            {(id, d) => <Input id={id} aria-describedby={d} aria-invalid={!!error} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
        </div>
      </Dialog>

      <Dialog open={!!secret} onClose={() => setSecret(null)} title="Your app password" description="Copy it now. It won't be shown again."
        footer={<Button variant="primary" onClick={() => setSecret(null)}>Done</Button>}
      >
        {secret && (
          <div className="space-y-3">
            <p className="rounded-[10px] bg-surface-2 p-4 text-center font-mono text-[15px] font-medium tracking-wider break-all text-fg select-all">{secret}</p>
            <CopyButton text={secret} label="Copy password" />
          </div>
        )}
      </Dialog>
    </Section>
  );
}

export function SyncHelpSection() {
  const { user } = useMeData();
  const url = `${location.origin}/dav/`;

  const download = () => {
    const xml = buildMobileconfig({
      hostname: location.hostname,
      port: Number(location.port) || (location.protocol === 'https:' ? 443 : 80),
      ssl: location.protocol === 'https:',
      email: user.email,
      userId: user.id,
      name: user.name,
    });
    const href = URL.createObjectURL(new Blob([xml], { type: 'application/x-apple-aspen-config' }));
    const a = document.createElement('a');
    a.href = href;
    a.download = 'cirrus-mail.mobileconfig';
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <Section title="Sync contacts & calendars" description="Use CardDAV and CalDAV to keep Apple Contacts and Calendar, Thunderbird or DAVx5 up to date.">
      <dl className="grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[110px_1fr]">
        <dt className="text-muted">Server</dt>
        <dd className="flex min-w-0 items-center gap-1"><code className="truncate font-mono">{url}</code><CopyButton text={url} label="Copy" /></dd>
        <dt className="text-muted">Username</dt>
        <dd className="flex min-w-0 items-center gap-1"><code className="truncate font-mono">{user.email}</code><CopyButton text={user.email} label="Copy" /></dd>
        <dt className="text-muted">Password</dt>
        <dd>An app password from above, not your account password.</dd>
      </dl>
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-[13px] text-muted">
        <li>Create an app password above and keep it handy.</li>
        <li><span className="text-fg">iPhone, iPad:</span> Settings, Calendar (or Contacts), Accounts, Add Account, Other, then Add CalDAV (or CardDAV) Account. Enter the server, username and app password.</li>
        <li><span className="text-fg">Mac:</span> System Settings, Internet Accounts, Add Other Account, then CalDAV or CardDAV account, Manual.</li>
        <li><span className="text-fg">Android:</span> in DAVx5, add an account with a URL and username, and use the server above.</li>
      </ol>
      <div className="mt-4">
        <Button size="sm" icon={<Download size={13} />} onClick={download}>Download Apple profile</Button>
        <p className="mt-1.5 text-[12px] text-muted">Adds both accounts to an iPhone, iPad or Mac, prefilled with the server and your username. You enter the app password when you install it.</p>
      </div>
    </Section>
  );
}
