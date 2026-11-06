import { useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Label } from '@shared/api';
import { IconButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Menu } from '../../components/Menu';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { useLabelMutations, useLabels } from '../../lib/queries/labels';
import { LabelEditorDialog } from './LabelDialogs';
import { LabelDot } from './labelMeta';
import { Badge, railLinkClass } from './railStyles';

/** The rail's "Labels" section, under the custom folders: open a label, create, rename, recolour, delete. */
export function RailLabels({ mailboxId, onNavigate }: { mailboxId: string; onNavigate?: () => void }) {
  const labels = useLabels(mailboxId);
  const { remove } = useLabelMutations(mailboxId);
  const [editing, setEditing] = useState<Label | 'new' | null>(null);
  const confirm = useConfirm();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { folder: current } = useParams();

  const del = async (l: Label) => {
    const ok = await confirm({
      title: `Delete "${l.name}"?`,
      body: 'The label is removed from every conversation. The conversations themselves are kept.',
      confirmLabel: 'Delete label',
      danger: true,
    });
    if (!ok) return;
    remove.mutate(l.id, {
      onSuccess: () => current === `label:${l.id}` && navigate(`/mail/${mailboxId}/inbox`),
      onError: (e) => toast({ tone: 'error', title: 'Label not deleted', description: errorMessage(e) }),
    });
  };

  return (
    <div className="mt-5">
      <div className="flex h-7 items-center justify-between pl-2">
        <h3 className="text-[12px] font-medium text-faint">Labels</h3>
        <IconButton label="New label" tipAlign="end" onClick={() => setEditing('new')} className="size-6">
          <Plus size={14} />
        </IconButton>
      </div>
      <ul className="space-y-px">
        {(labels.data ?? []).map((l) => (
          <li key={l.id} className="group/f relative">
            <NavLink to={`/mail/${mailboxId}/label:${l.id}`} onClick={onNavigate} className={({ isActive }) => railLinkClass(isActive)}>
              <span className="flex size-4 items-center justify-center"><LabelDot color={l.color} /></span>
              <span className="truncate pr-6">{l.name}</span>
              <span className="group-hover/f:invisible group-focus-within/f:invisible ml-auto pointer-coarse:mr-9 pointer-coarse:group-focus-within/f:visible">
                <Badge n={l.unread} />
              </span>
            </NavLink>
            <div className="absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 group-hover/f:opacity-100 group-focus-within/f:opacity-100 pointer-coarse:opacity-100">
              <Menu
                label={`${l.name} options`}
                width={180}
                items={[
                  { label: 'Rename or recolour', icon: <Pencil />, onSelect: () => setEditing(l) },
                  { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void del(l) },
                ]}
                trigger={(p) => (
                  <IconButton {...p} noTip label={`${l.name} options`} className="size-6">
                    <MoreHorizontal size={14} />
                  </IconButton>
                )}
              />
            </div>
          </li>
        ))}
        {labels.data && !labels.data.length && <li className="flex h-7 items-center px-2 text-[12px] text-faint">No labels yet</li>}
      </ul>
      {editing && <LabelEditorDialog mailboxId={mailboxId} label={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
