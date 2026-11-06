import { AlarmClock, Archive, FolderInput, Mail, MailOpen, ShieldAlert, ShieldCheck, Star, StarOff, Tag, Trash2, X } from 'lucide-react';
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
  onSnooze: () => void;
  onLabel: () => void;
}

export function BulkBar({ count, total, role, folders, onAction, onSelectAll, onSnooze, onLabel }: Props) {
  const trashLike = role === 'trash' || role === 'spam';
  const movable = folders.filter((f) => f.role === 'inbox' || f.role === 'archive' || !f.role);
  return (
    <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-border bg-bg pr-3 pl-1" role="toolbar" aria-label="Bulk actions">
      <IconButton label="Clear selection" shortcut="Esc" tipAlign="start" onClick={() => onSelectAll(false)}><X size={16} /></IconButton>
      <span className="tnum mr-auto min-w-0 truncate pl-1 text-[13px] font-medium text-fg">
        {count} selected
        {count < total && (
          <button type="button" onClick={() => onSelectAll(true)} className="ml-2 font-normal text-selected-fg hover:underline">
            Select all {total}
          </button>
        )}
      </span>
      {role !== 'archive' && <IconButton label="Archive" shortcut="E" onClick={() => onAction('archive')}><Archive size={16} /></IconButton>}
      {trashLike ? (
        <IconButton label="Delete forever" onClick={() => onAction('delete_forever')}><Trash2 size={16} className="text-danger" /></IconButton>
      ) : (
        <IconButton label="Move to Trash" shortcut="#" onClick={() => onAction('trash')}><Trash2 size={16} /></IconButton>
      )}
      {role === 'spam' ? (
        <IconButton label="Not spam" onClick={() => onAction('not_spam')}><ShieldCheck size={16} /></IconButton>
      ) : (
        <IconButton label="Mark as spam" onClick={() => onAction('spam')}><ShieldAlert size={16} /></IconButton>
      )}
      <IconButton label="Snooze" shortcut="B" onClick={onSnooze}><AlarmClock size={16} /></IconButton>
      <IconButton label="Mark as read" shortcut="⇧I" onClick={() => onAction('read')}><MailOpen size={16} /></IconButton>
      <IconButton label="Mark as unread" shortcut="⇧U" onClick={() => onAction('unread')}><Mail size={16} /></IconButton>
      <IconButton label="Star" onClick={() => onAction('star')}><Star size={16} /></IconButton>
      <IconButton label="Remove star" className="max-sm:hidden" onClick={() => onAction('unstar')}><StarOff size={16} /></IconButton>
      <IconButton label="Label as" shortcut="L" onClick={onLabel}><Tag size={16} /></IconButton>
      <Menu
        label="Move to folder"
        items={movable.length ? movable.map((f) => ({ label: f.name, onSelect: () => onAction('move', f.id) })) : [{ kind: 'heading', label: 'No folders' }]}
        trigger={(p) => (
          <IconButton {...p} label="Move to folder" tipAlign="end"><FolderInput size={16} /></IconButton>
        )}
      />
    </div>
  );
}
