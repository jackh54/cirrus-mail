import { useState } from 'react';
import { KeyRound, MailPlus, MoreHorizontal, Shield, ShieldOff, Trash2, UserCheck, UserX } from 'lucide-react';
import type { AdminInviteResponse, AdminUser } from '@shared/api';
import { Avatar } from '../../components/Avatar';
import { Button, IconButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { Menu } from '../../components/Menu';
import { PageTitle } from '../../components/PageShell';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { relativeAgo } from '../../lib/format';
import { useAdminUsers, useUserMutations } from '../../lib/queries/admin';
import { useMeData } from '../../lib/queries/me';
import { InviteResultDialog, InviteUserDialog } from './InviteUserDialog';
import { genPassword, Pill, Table } from './shared';

export function UsersPage() {
  const users = useAdminUsers();
  const { update, remove, resendInvite } = useUserMutations();
  const { user: me } = useMeData();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [resent, setResent] = useState<AdminInviteResponse | null>(null);
  const onError = (e: unknown) => toast({ tone: 'error', title: 'Not saved', description: errorMessage(e) });

  return (
    <>
      <PageTitle title="Users" description="People who can sign in. Give them mailboxes on the Mailboxes page." action={<Button variant="primary" icon={<MailPlus size={15} />} onClick={() => setCreating(true)}>Invite user</Button>} />
      {users.isPending ? (
        <Skeleton className="h-48 rounded-[10px]" />
      ) : users.isError ? (
        <p className="text-[13px] text-danger">{errorMessage(users.error)}</p>
      ) : (
        <Table head={['User', 'Role', 'Mailboxes', 'Created', '']}>
          {users.data.map((u) => (
            <tr key={u.id} className={u.disabled ? 'opacity-60' : undefined}>
              <td>
                <div className="flex items-center gap-3">
                  <Avatar address={{ email: u.email, name: u.name }} size={28} />
                  <div className="min-w-0">
                    <p className="truncate leading-5 font-medium">{u.name} {u.id === me.id && <span className="text-[12px] font-normal text-faint">(you)</span>}</p>
                    <p className="truncate text-[12px] leading-4 text-muted">{u.email}</p>
                  </div>
                </div>
              </td>
              <td>
                <div className="flex flex-wrap gap-1">
                  <Pill tone={u.role === 'admin' ? 'primary' : 'neutral'}>{u.role === 'admin' ? 'Admin' : 'Member'}</Pill>
                  {u.disabled && <Pill tone="danger">Disabled</Pill>}
                  {u.invite && (u.invite.expiresAt < Date.now() ? <Pill tone="warning">Invite expired</Pill> : <Pill>Invited</Pill>)}
                  {u.totpEnabled && <Pill tone="success">2FA</Pill>}
                </div>
              </td>
              <td className="tabular-nums">{u.mailboxCount}</td>
              <td className="text-muted">{relativeAgo(u.createdAt)}</td>
              <td>
                <Menu
                  label={`Actions for ${u.name}`}
                  items={[
                    u.invite
                      ? { label: 'Resend invite', icon: <MailPlus />, onSelect: () => resendInvite.mutate(u.id, { onSuccess: setResent, onError: (e) => toast({ tone: 'error', title: 'Not sent', description: errorMessage(e) }) }) }
                      : { label: 'Reset password', icon: <KeyRound />, onSelect: () => setResetting(u) },
                    u.role === 'admin'
                      ? { label: 'Make member', icon: <ShieldOff />, disabled: u.id === me.id, onSelect: () => update.mutate({ id: u.id, patch: { role: 'member' } }, { onError }) }
                      : { label: 'Make admin', icon: <Shield />, onSelect: () => update.mutate({ id: u.id, patch: { role: 'admin' } }, { onError }) },
                    u.disabled
                      ? { label: 'Enable', icon: <UserCheck />, onSelect: () => update.mutate({ id: u.id, patch: { disabled: false } }, { onError }) }
                      : {
                          label: 'Disable',
                          icon: <UserX />,
                          disabled: u.id === me.id,
                          onSelect: async () => {
                            if (await confirm({ title: `Disable ${u.name}?`, body: 'They are signed out everywhere and cannot sign in. Their mail is kept.', confirmLabel: 'Disable', danger: true }))
                              update.mutate({ id: u.id, patch: { disabled: true } }, { onError });
                          },
                        },
                    { kind: 'separator' },
                    {
                      label: u.invite ? 'Revoke invite' : 'Delete user',
                      icon: <Trash2 />,
                      danger: true,
                      disabled: u.id === me.id,
                      onSelect: async () => {
                        if (await confirm(
                          u.invite
                            ? { title: `Revoke the invite for ${u.name}?`, body: 'Their link stops working and the pending account is removed.', confirmLabel: 'Revoke invite', danger: true }
                            : { title: `Delete ${u.name}?`, body: 'This removes their account and signs them out everywhere.', confirmLabel: 'Delete user', danger: true },
                        ))
                          remove.mutate(u.id, { onError });
                      },
                    },
                  ]}
                  trigger={(p) => <IconButton {...p} label={`Actions for ${u.name}`} size="sm"><MoreHorizontal size={15} /></IconButton>}
                />
              </td>
            </tr>
          ))}
        </Table>
      )}
      {creating && <InviteUserDialog onClose={() => setCreating(false)} />}
      {resent && <InviteResultDialog result={resent} onClose={() => setResent(null)} />}
      {resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />}
    </>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { update } = useUserMutations();
  const { toast } = useToast();
  const [pw, setPw] = useState(genPassword);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reset password for ${user.name}`}
      description="They will be asked to choose a new password after signing in. Share this temporary password privately."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={pw.length < 10}
            onClick={() =>
              update.mutate(
                { id: user.id, patch: { resetPassword: pw } },
                {
                  onSuccess: () => {
                    void navigator.clipboard?.writeText(pw).catch(() => undefined);
                    toast({ tone: 'success', title: 'Password reset', description: 'The temporary password was copied to your clipboard.' });
                    onClose();
                  },
                  onError: (e) => toast({ tone: 'error', title: 'Not reset', description: errorMessage(e) }),
                },
              )
            }
          >
            Reset password
          </Button>
        </>
      }
    >
      <Field label="Temporary password">
        {(id) => (
          <div className="flex gap-2">
            <Input id={id} value={pw} onChange={(e) => setPw(e.target.value)} className="font-mono" />
            <Button onClick={() => setPw(genPassword())}>Generate</Button>
          </div>
        )}
      </Field>
    </Dialog>
  );
}
