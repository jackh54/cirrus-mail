import { Archive, FolderInput, Mail, MailOpen, ShieldAlert, ShieldCheck, Star, StarOff, Trash2, X } from 'lucide-react';
import type { Folder, ThreadAction } from '@shared/api';
import { IconButton } from '../../components/Button';
import { Menu } from '../../components/Menu';
import type { ViewRole } from './folderMeta';

interface Props {
  count: number;
  total: number;
  role: ViewRole;
  folders: Folder[];
  onAction: (a: ThreadAction, folderId?: string) => void;
  onSelectAll: (on: boolean) => void;
}

export function BulkBar({ count, total, role, folders, onAction, onSelectAll }: Props) {
  const trashLike = role === 'trash' || role === 'spam';
  const movable = folders.filter((f) => f.role === 'inbox' || f.role === 'archive' || !f.role);
  return (
    <div className="flex h-11 items-center gap-1 border-b border-border bg-primary-soft px-2 animate-fade-in" role="toolbar" aria-label="Bulk actions">
      <IconButton label="Clear selection" size="sm" onClick={() => onSelectAll(false)}><X size={15} /></IconButton>
      <span className="mr-auto pl-1 text-[13px] font-medium text-fg">
        {count} selected
        {count < total && (
          <button type="button" onClick={() => onSelectAll(true)} className="ml-2 font-normal text-primary hover:underline">
            Select all {total}
          </button>
        )}
      </span>
      {role !== 'archive' && <IconButton label="Archive" size="sm" onClick={() => onAction('archive')}><Archive size={15} /></IconButton>}
      {trashLike ? (
        <IconButton label="Delete forever" size="sm" onClick={() => onAction('delete_forever')}><Trash2 size={15} className="text-danger" /></IconButton>
      ) : (
        <IconButton label="Move to Trash" size="sm" onClick={() => onAction('trash')}><Trash2 size={15} /></IconButton>
      )}
      {role === 'spam' ? (
        <IconButton label="Not spam" size="sm" onClick={() => onAction('not_spam')}><ShieldCheck size={15} /></IconButton>
      ) : (
        <IconButton label="Mark as spam" size="sm" onClick={() => onAction('spam')}><ShieldAlert size={15} /></IconButton>
      )}
      <IconButton label="Mark as read" size="sm" onClick={() => onAction('read')}><MailOpen size={15} /></IconButton>
      <IconButton label="Mark as unread" size="sm" onClick={() => onAction('unread')}><Mail size={15} /></IconButton>
      <IconButton label="Star" size="sm" onClick={() => onAction('star')}><Star size={15} /></IconButton>
      <IconButton label="Remove star" size="sm" className="max-sm:hidden" onClick={() => onAction('unstar')}><StarOff size={15} /></IconButton>
      <Menu
        label="Move to folder"
        items={movable.length ? movable.map((f) => ({ label: f.name, onSelect: () => onAction('move', f.id) })) : [{ kind: 'heading', label: 'No folders' }]}
        trigger={(p) => (
          <IconButton {...p} label="Move to folder" size="sm"><FolderInput size={15} /></IconButton>
        )}
      />
    </div>
  );
}
