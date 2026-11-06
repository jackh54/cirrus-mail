import { Archive, ArrowLeft, ChevronDown, ChevronUp, FolderInput, Mail, ShieldAlert, ShieldCheck, Star, Trash2 } from 'lucide-react';
import type { Folder, ThreadAction } from '@shared/api';
import { IconButton } from '../../components/Button';
import { Menu } from '../../components/Menu';
import type { ViewRole } from './folderMeta';

interface Props {
  role: ViewRole | undefined;
  starred: boolean;
  folders: Folder[];
  showBack: boolean;
  onBack: () => void;
  onAction: (a: ThreadAction, folderId?: string) => void;
  onStep?: (delta: number) => void;
}

export function ReaderToolbar({ role, starred, folders, showBack, onBack, onAction, onStep }: Props) {
  const trashLike = role === 'trash' || role === 'spam';
  const movable = folders.filter((f) => f.role === 'inbox' || f.role === 'archive' || !f.role);
  return (
    <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-border bg-bg px-3" role="toolbar" aria-label="Conversation actions">
      {showBack && (
        <IconButton label="Back to list" shortcut="U" tipAlign="start" size="md" onClick={onBack} className="mr-1 -ml-1">
          <ArrowLeft size={18} />
        </IconButton>
      )}
      {role !== 'archive' && <IconButton label="Archive" shortcut="E" tipAlign={showBack ? undefined : 'start'} onClick={() => onAction('archive')}><Archive size={16} /></IconButton>}
      {trashLike ? (
        <IconButton label="Delete forever" shortcut="#" onClick={() => onAction('delete_forever')}><Trash2 size={16} className="text-danger" /></IconButton>
      ) : (
        <IconButton label="Move to Trash" shortcut="#" onClick={() => onAction('trash')}><Trash2 size={16} /></IconButton>
      )}
      {role === 'spam' ? (
        <IconButton label="Not spam" onClick={() => onAction('not_spam')}><ShieldCheck size={16} /></IconButton>
      ) : (
        <IconButton label="Mark as spam" onClick={() => onAction('spam')}><ShieldAlert size={16} /></IconButton>
      )}
      <Menu
        label="Move to folder"
        align="start"
        items={movable.length ? movable.map((f) => ({ label: f.name, onSelect: () => onAction('move', f.id) })) : [{ kind: 'heading', label: 'No folders' }]}
        trigger={(p) => <IconButton {...p} label="Move to folder"><FolderInput size={16} /></IconButton>}
      />
      <span className="mx-1.5 h-4 w-px bg-border" aria-hidden="true" />
      <IconButton label="Mark as unread" shortcut="⇧U" onClick={() => onAction('unread')}><Mail size={16} /></IconButton>
      <IconButton label={starred ? 'Unstar' : 'Star'} shortcut="S" onClick={() => onAction(starred ? 'unstar' : 'star')}>
        <Star size={16} className={starred ? 'fill-amber-400 text-amber-400' : undefined} />
      </IconButton>
      {onStep && (
        <span className="ml-auto flex gap-0.5 max-md:hidden">
          <IconButton label="Newer conversation" shortcut="K" tipAlign="end" onClick={() => onStep(-1)}><ChevronUp size={16} /></IconButton>
          <IconButton label="Older conversation" shortcut="J" tipAlign="end" onClick={() => onStep(1)}><ChevronDown size={16} /></IconButton>
        </span>
      )}
    </div>
  );
}
