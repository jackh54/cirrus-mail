import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { AdminInviteInput, AdminInviteResponse, Role } from '@shared/api';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Input, Select } from '../../components/Field';
import { errorMessage } from '../../lib/api';
import { isValidEmail, longDate } from '../../lib/format';
import { useAdminDomains, useUserMutations } from '../../lib/queries/admin';
import { CreateUserDialog } from './CreateUserDialog';

function resultMessage(r: AdminInviteResponse): string | null {
  const to = r.user.email;
  if (r.email.sent) return null;
  switch (r.email.reason) {
    case 'HOSTED_HERE': return `${to} is on a domain Cirrus hosts here, so they can't read it yet. Send them the link another way.`;
    case 'NO_SENDING_DOMAIN': return 'Add a domain first so Cirrus has an address to send from. You can share the link yourself meanwhile.';
    case 'SEND_FAILED': return r.email.error ?? 'The email could not be sent.';
    default: return null;
  }
}

/** Shown after an invite is created or resent: whether the email went out, plus the link to share by hand. */
export function InviteResultDialog({ result, onClose }: { result: AdminInviteResponse; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const note = resultMessage(result);
  const expires = result.user.invite?.expiresAt;
  const copy = () => {
    void navigator.clipboard?.writeText(result.inviteUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }, () => undefined);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={result.email.sent ? 'Invite sent' : 'Invite ready'}
      width={520}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="space-y-4">
        {result.email.sent ? (
          <p className="text-[13px]">Invite sent to <strong className="font-medium">{result.user.email}</strong> (from {result.email.from}).</p>
        ) : note && (
          <p role={result.email.reason === 'SEND_FAILED' ? 'alert' : undefined} className={result.email.reason === 'SEND_FAILED' ? 'rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger' : 'text-[13px]'}>{note}</p>
        )}
        <Field label="Invite link" hint={expires ? `Expires ${longDate(expires)}. Anyone with the link can set the password, so share it privately.` : undefined}>
          {(id, d) => (
            <div className="flex gap-2">
              <Input id={id} aria-describedby={d} readOnly value={result.inviteUrl} onFocus={(e) => e.currentTarget.select()} className="font-mono" />
              <Button icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

export function InviteUserDialog({ onClose }: { onClose: () => void }) {
  const { invite } = useUserMutations();
  const domains = useAdminDomains();
  const [f, setF] = useState({ name: '', email: '', role: 'member' as Role, localPart: '', domainId: '' });
  const [withMailbox, setWithMailbox] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminInviteResponse | null>(null);
  const [usePassword, setUsePassword] = useState(false);
  const domainId = f.domainId || domains.data?.[0]?.id || '';
  const valid = f.name.trim() && isValidEmail(f.email) && (!withMailbox || (f.localPart.trim() && domainId));

  if (usePassword) return <CreateUserDialog onClose={onClose} />;
  if (result) return <InviteResultDialog result={result} onClose={onClose} />;

  const submit = () => {
    const input: AdminInviteInput = {
      name: f.name.trim(),
      email: f.email.trim(),
      role: f.role,
      mailbox: withMailbox ? { localPart: f.localPart.trim().toLowerCase(), domainId } : undefined,
    };
    invite.mutate(input, { onSuccess: setResult, onError: (e) => setError(errorMessage(e)) });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Invite user"
      width={520}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => setUsePassword(true)}>Set a password instead</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={invite.isPending} onClick={submit}>Send invite</Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Role">
            {(id) => (
              <Select id={id} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value === 'admin' ? 'admin' : 'member' })}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="Sign-in email" hint="An address they can already read, like their personal email. They'll get a link to set their password.">
          {(id, d) => <Input id={id} aria-describedby={d} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}
        </Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={withMailbox} onChange={(e) => setWithMailbox(e.target.checked)} className="size-4" disabled={!domains.data?.length} />
          Create a mailbox
          {!domains.data?.length && <span className="text-[12px] text-faint">(add a domain first)</span>}
        </label>
        {withMailbox && (
          <div className="flex items-end gap-2">
            <Field label="Address" className="flex-1">{(id) => <Input id={id} value={f.localPart} placeholder="alex" onChange={(e) => setF({ ...f, localPart: e.target.value })} />}</Field>
            <span className="pb-2 text-muted">@</span>
            <Select aria-label="Domain" value={domainId} onChange={(e) => setF({ ...f, domainId: e.target.value })} className="flex-1">
              {domains.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </div>
        )}
      </div>
    </Dialog>
  );
}
