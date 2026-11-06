import type { ReactNode } from 'react';
import { Archive, ArrowLeft, ChevronDown, ChevronUp, FolderInput, Forward, Mail, Reply, ReplyAll, ShieldAlert, ShieldCheck, Star, Tag, Trash2 } from 'lucide-react';
import type { Folder, ThreadAction } from '@shared/api';
import { IconButton } from '../../components/Button';
import { Menu } from '../../components/Menu';
import { cn } from '../../lib/cn';
import type { ViewRole } from './folderMeta';

interface Props {
  role: ViewRole | undefined;
  starred: boolean;
  folders: Folder[];
  showBack: boolean;
  onBack: () => void;
  onAction: (a: ThreadAction, folderId?: string) => void;
  onStep?: (delta: number) => void;
  onLabels: () => void;
  /** Phones: only back, spam and star up here; the rest lives in the bottom ReaderActionBar. */
  mobile?: boolean;
}

export function ReaderToolbar({ role, starred, folders, showBack, onBack, onAction, onStep, onLabels, mobile }: Props) {
  const trashLike = role === 'trash' || role === 'spam';
  const movable = folders.filter((f) => f.role === 'inbox' || f.role === 'archive' || !f.role);
  if (mobile) {
    return (
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-bg px-2" role="toolbar" aria-label="Conversation">
        <IconButton label="Back to list" noTip size="md" onClick={onBack} className="size-11">
          <ArrowLeft size={20} />
        </IconButton>
        <span className="flex-1" />
        {role === 'spam' ? (
          <IconButton label="Not spam" noTip onClick={() => onAction('not_spam')} className="size-11"><ShieldCheck size={18} /></IconButton>
        ) : (
          <IconButton label="Mark as spam" noTip onClick={() => onAction('spam')} className="size-11"><ShieldAlert size={18} /></IconButton>
        )}
        <IconButton label={starred ? 'Unstar' : 'Star'} noTip onClick={() => onAction(starred ? 'unstar' : 'star')} className="size-11">
          <Star size={18} className={starred ? 'fill-amber-400 text-amber-400' : undefined} />
        </IconButton>
      </div>
    );
  }
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
      <IconButton label="Label as" shortcut="L" onClick={onLabels}><Tag size={16} /></IconButton>
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

interface BarProps {
  role: ViewRole | undefined;
  folders: Folder[];
  onAction: (a: ThreadAction, folderId?: string) => void;
  onReply: (mode: 'reply' | 'reply_all' | 'forward') => void;
  onLabels: () => void;
  canReply: boolean;
}

/** Phone reader: the main actions in a bottom bar within thumb reach, padded above the home indicator. */
export function ReaderActionBar({ role, folders, onAction, onReply, onLabels, canReply }: BarProps) {
  const trashLike = role === 'trash' || role === 'spam';
  const movable = folders.filter((f) => f.role === 'inbox' || f.role === 'archive' || !f.role);
  return (
    <div
      role="toolbar"
      aria-label="Conversation actions"
      className="flex shrink-0 items-center justify-around border-t border-border bg-bg px-2 pt-0.5 pb-[max(0.125rem,env(safe-area-inset-bottom))]"
    >
      <BarButton label="Archive" disabled={role === 'archive'} onClick={() => onAction('archive')}><Archive /></BarButton>
      {trashLike ? (
        <BarButton label="Delete forever" onClick={() => onAction('delete_forever')} className="text-danger"><Trash2 /></BarButton>
      ) : (
        <BarButton label="Move to Trash" onClick={() => onAction('trash')}><Trash2 /></BarButton>
      )}
      <Menu
        label="Move to folder"
        align="start"
        items={movable.length ? movable.map((f) => ({ label: f.name, icon: <FolderInput />, onSelect: () => onAction('move', f.id) })) : [{ kind: 'heading', label: 'No folders' }]}
        trigger={(p) => <BarButton {...p} label="Move to folder"><FolderInput /></BarButton>}
      />
      <BarButton label="Label as" onClick={onLabels}><Tag /></BarButton>
      <BarButton label="Mark as unread" onClick={() => onAction('unread')}><Mail /></BarButton>
      <Menu
        label="Reply options"
        width={200}
        items={[
          { label: 'Reply', icon: <Reply />, onSelect: () => onReply('reply') },
          { label: 'Reply all', icon: <ReplyAll />, onSelect: () => onReply('reply_all') },
          { label: 'Forward', icon: <Forward />, onSelect: () => onReply('forward') },
        ]}
        trigger={(p) => <BarButton {...p} label="Reply options" disabled={!canReply}><Reply /></BarButton>}
      />
    </div>
  );
}

function BarButton({ label, className, children, ...rest }: Omit<React.ComponentProps<typeof IconButton>, 'label'> & { label: string; children: ReactNode }) {
  return (
    <IconButton {...rest} label={label} noTip className={cn('size-11 rounded-lg active:bg-hover [&_svg]:size-[22px]', className)}>
      {children}
    </IconButton>
  );
}
