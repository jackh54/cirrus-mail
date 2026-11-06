import { useState, type FormEvent } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { Folder as FolderIcon, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Folder } from '@shared/api';
import { IconButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Menu } from '../../components/Menu';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { useFolderMutations } from '../../lib/queries/mail';
import { Badge, railLinkClass } from './railStyles';

export function CustomFolders({ mailboxId, folders, onNavigate }: { mailboxId: string; folders: Folder[]; onNavigate?: () => void }) {
  const { create, rename, remove } = useFolderMutations(mailboxId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const confirm = useConfirm();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { folder: current } = useParams();
  const sorted = [...folders].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

  const onError = (e: unknown) => toast({ tone: 'error', title: 'Folder not saved', description: errorMessage(e) });

  const del = async (f: Folder) => {
    const ok = await confirm({
      title: `Delete "${f.name}"?`,
      body: f.total ? `It contains ${f.total} message${f.total === 1 ? '' : 's'}.` : 'The folder is empty.',
      confirmLabel: 'Delete folder',
      danger: true,
    });
    if (!ok) return;
    remove.mutate(f.id, {
      onSuccess: () => current === f.id && navigate(`/mail/${mailboxId}/inbox`),
      onError,
    });
  };

  return (
    <div className="mt-5">
      <div className="mb-1 flex items-center justify-between pr-0.5 pl-2.5">
        <h3 className="text-[11px] font-semibold tracking-wide text-faint uppercase">Folders</h3>
        <IconButton label="New folder" size="sm" onClick={() => setAdding(true)}>
          <Plus size={14} />
        </IconButton>
      </div>
      <ul className="space-y-0.5">
        {sorted.map((f) =>
          editing === f.id ? (
            <li key={f.id}>
              <NameInput
                initial={f.name}
                onCancel={() => setEditing(null)}
                onSubmit={(name) => rename.mutate({ id: f.id, name }, { onSuccess: () => setEditing(null), onError })}
              />
            </li>
          ) : (
            <li key={f.id} className="group/f relative">
              <NavLink to={`/mail/${mailboxId}/${f.id}`} onClick={onNavigate} className={({ isActive }) => railLinkClass(isActive)}>
                <FolderIcon size={16} />
                <span className="truncate pr-6">{f.name}</span>
                <span className="group-hover/f:invisible group-focus-within/f:invisible ml-auto">
                  <Badge n={f.unread} />
                </span>
              </NavLink>
              <div className="absolute top-0.5 right-0.5 opacity-0 transition-opacity group-hover/f:opacity-100 group-focus-within/f:opacity-100">
                <Menu
                  label={`${f.name} options`}
                  width={180}
                  items={[
                    { label: 'Rename', icon: <Pencil />, onSelect: () => setEditing(f.id) },
                    { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => void del(f) },
                  ]}
                  trigger={(p) => (
                    <IconButton {...p} size="sm" label={`${f.name} options`}>
                      <MoreHorizontal size={14} />
                    </IconButton>
                  )}
                />
              </div>
            </li>
          ),
        )}
        {adding && (
          <li>
            <NameInput
              initial=""
              onCancel={() => setAdding(false)}
              onSubmit={(name) => create.mutate(name, { onSuccess: () => setAdding(false), onError })}
            />
          </li>
        )}
        {!sorted.length && !adding && <li className="px-2.5 py-1 text-xs text-faint">No folders yet</li>}
      </ul>
    </div>
  );
}

function NameInput({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n && n !== initial) onSubmit(n);
    else onCancel();
  };
  return (
    <form onSubmit={submit} className="px-1">
      <input
        autoFocus
        aria-label="Folder name"
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
        className="h-8 w-full rounded-lg border border-primary bg-surface px-2 text-[13.5px] outline-none ring-3 ring-ring/30"
      />
    </form>
  );
}
