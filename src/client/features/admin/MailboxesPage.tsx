import { useState } from 'react';
import { Inbox, Pencil, Plus, Trash2, Users } from 'lucide-react';
import type { AdminMailbox } from '@shared/api';
import { Button, IconButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { Field, Input, Select } from '../../components/Field';
import { PageTitle } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { useAdminDomains, useAdminMailboxes, useAdminUsers, useMailboxMutations } from '../../lib/queries/admin';
import { MembersEditor, type Member } from './MembersEditor';
import { Table } from './shared';

export function MailboxesPage() {
  const mailboxes = useAdminMailboxes();
  const { remove } = useMailboxMutations();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [editing, setEditing] = useState<AdminMailbox | 'new' | null>(null);

  return (
    <>
      <PageTitle title="Mailboxes" description="Each mailbox is an address with its own folders. Several members make it a shared mailbox." action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>New mailbox</Button>} />
      {mailboxes.isPending ? (
        <Skeleton className="h-48 rounded-2xl" />
      ) : mailboxes.isError ? (
        <p className="text-sm text-danger">{errorMessage(mailboxes.error)}</p>
      ) : !mailboxes.data.length ? (
        <div className="rounded-2xl border border-dashed border-border-strong">
          <EmptyState icon={<Inbox size={24} />} title="No mailboxes yet" body="Create one for yourself first, then for the rest of your team." />
        </div>
      ) : (
        <Table head={['Address', 'Members', 'Messages', '']}>
          {mailboxes.data.map((m) => (
            <tr key={m.id}>
              <td className="px-4 py-3">
                <p className="font-medium">{m.address}</p>
                <p className="text-[12.5px] text-muted">{m.displayName}</p>
              </td>
              <td className="px-4 py-3">
                <span className="flex items-center gap-1.5 text-muted" title={m.members.map((x) => `${x.name} (${x.role})`).join(', ')}>
                  <Users size={14} /> {m.members.map((x) => x.name.split(' ')[0]).join(', ') || 'None'}
                </span>
              </td>
              <td className="px-4 py-3 tabular-nums">{m.messageCount.toLocaleString()}</td>
              <td className="px-2 py-3">
                <div className="flex justify-end">
                  <IconButton label={`Edit ${m.address}`} size="sm" onClick={() => setEditing(m)}><Pencil size={14} /></IconButton>
                  <IconButton
                    label={`Delete ${m.address}`}
                    size="sm"
                    onClick={async () => {
                      if (await confirm({ title: `Delete ${m.address}?`, body: `All ${m.messageCount.toLocaleString()} messages and attachments are permanently deleted.`, confirmLabel: 'Delete mailbox', danger: true }))
                        remove.mutate(m.id, { onError: (e) => toast({ tone: 'error', title: 'Not deleted', description: errorMessage(e) }) });
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {editing && <MailboxDialog mailbox={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function MailboxDialog({ mailbox, onClose }: { mailbox: AdminMailbox | null; onClose: () => void }) {
  const domains = useAdminDomains();
  const users = useAdminUsers();
  const { create, update } = useMailboxMutations();
  const { toast } = useToast();
  const [localPart, setLocalPart] = useState('');
  const [domainId, setDomainId] = useState('');
  const [displayName, setDisplayName] = useState(mailbox?.displayName ?? '');
  const [members, setMembers] = useState<Member[]>(mailbox?.members.map((m) => ({ userId: m.userId, role: m.role })) ?? []);
  const [error, setError] = useState<string | null>(null);
  const dom = domainId || domains.data?.[0]?.id || '';
  const valid = mailbox ? true : /^[a-z0-9._+-]+$/i.test(localPart.trim()) && !!dom;

  const save = () => {
    const opts = {
      onSuccess: () => {
        toast({ tone: 'success', title: mailbox ? 'Mailbox updated' : 'Mailbox created' });
        onClose();
      },
      onError: (e: unknown) => setError(errorMessage(e)),
    };
    if (mailbox) update.mutate({ id: mailbox.id, patch: { displayName: displayName.trim(), members } }, opts);
    else create.mutate({ localPart: localPart.trim().toLowerCase(), domainId: dom, displayName: displayName.trim(), members }, opts);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={mailbox ? `Edit ${mailbox.address}` : 'New mailbox'}
      width={540}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} loading={create.isPending || update.isPending} onClick={save}>{mailbox ? 'Save' : 'Create mailbox'}</Button></>}
    >
      <div className="space-y-4">
        {error && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
        {!mailbox && (
          domains.data?.length === 0 ? (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">Add a domain first.</p>
          ) : (
            <div className="flex items-end gap-2">
              <Field label="Address" className="flex-1">{(id) => <Input id={id} autoFocus value={localPart} placeholder="hello" onChange={(e) => setLocalPart(e.target.value)} />}</Field>
              <span className="pb-2 text-muted">@</span>
              <Select aria-label="Domain" value={dom} onChange={(e) => setDomainId(e.target.value)} className="flex-1">
                {domains.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </div>
          )
        )}
        <Field label="Display name" hint="Default sender name, e.g. “Acme Support”.">
          {(id, d) => <Input id={id} aria-describedby={d} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">Members</p>
          <MembersEditor users={users.data ?? []} value={members} onChange={setMembers} />
        </div>
      </div>
    </Dialog>
  );
}
