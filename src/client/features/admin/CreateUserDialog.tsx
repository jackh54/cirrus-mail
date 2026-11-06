import { useState } from 'react';
import type { AdminCreateUserInput, Role } from '@shared/api';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Input, Select } from '../../components/Field';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { isValidEmail } from '../../lib/format';
import { useAdminDomains, useUserMutations } from '../../lib/queries/admin';
import { genPassword } from './shared';

export function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const { create } = useUserMutations();
  const domains = useAdminDomains();
  const { toast } = useToast();
  const [f, setF] = useState({ name: '', email: '', role: 'member' as Role, tempPassword: genPassword(), localPart: '', domainId: '' });
  const [withMailbox, setWithMailbox] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const domainId = f.domainId || domains.data?.[0]?.id || '';
  const valid = f.name.trim() && isValidEmail(f.email) && f.tempPassword.length >= 10 && (!withMailbox || (f.localPart.trim() && domainId));

  const submit = () => {
    const input: AdminCreateUserInput = {
      name: f.name.trim(),
      email: f.email.trim(),
      role: f.role,
      tempPassword: f.tempPassword,
      mailbox: withMailbox ? { localPart: f.localPart.trim().toLowerCase(), domainId } : undefined,
    };
    create.mutate(input, {
      onSuccess: () => {
        void navigator.clipboard?.writeText(f.tempPassword).catch(() => undefined);
        toast({ tone: 'success', title: `${input.name} added`, description: 'The temporary password was copied to your clipboard.' });
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add user"
      width={520}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} loading={create.isPending} onClick={submit}>Add user</Button></>}
    >
      <div className="space-y-4">
        {error && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">{(id) => <Input id={id} autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Sign-in email">{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Role">
            {(id) => (
              <Select id={id} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value === 'admin' ? 'admin' : 'member' })}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            )}
          </Field>
          <Field label="Temporary password" hint="They change it on first sign-in.">
            {(id, d) => <Input id={id} aria-describedby={d} className="font-mono" value={f.tempPassword} onChange={(e) => setF({ ...f, tempPassword: e.target.value })} />}
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={withMailbox} onChange={(e) => setWithMailbox(e.target.checked)} className="size-4" disabled={!domains.data?.length} />
          Also create a mailbox for them
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
