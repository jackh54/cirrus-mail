import type { ReactNode } from 'react';
import { Archive, Clock, FileText, Folder as FolderIcon, Inbox, Search, Send, ShieldAlert, Star, Trash2 } from 'lucide-react';
import type { Folder, FolderRole } from '@shared/api';

export type ViewRole = FolderRole | 'starred' | 'search' | 'custom';

interface Meta {
  label: string;
  icon: (size: number) => ReactNode;
  emptyTitle: string;
  emptyBody: string;
}

export const VIEW_META: Record<ViewRole, Meta> = {
  inbox: { label: 'Inbox', icon: (s) => <Inbox size={s} />, emptyTitle: "You're all caught up", emptyBody: 'Nothing new. Enjoy the quiet; new mail will land right here.' },
  starred: { label: 'Starred', icon: (s) => <Star size={s} />, emptyTitle: 'No starred conversations', emptyBody: 'Press s on a conversation to star it and keep it within reach.' },
  scheduled: { label: 'Scheduled', icon: (s) => <Clock size={s} />, emptyTitle: 'Nothing scheduled', emptyBody: 'Use the arrow next to Send to deliver a message later.' },
  drafts: { label: 'Drafts', icon: (s) => <FileText size={s} />, emptyTitle: 'No drafts', emptyBody: "Anything you start writing is saved here automatically until it's sent." },
  sent: { label: 'Sent', icon: (s) => <Send size={s} />, emptyTitle: 'Nothing sent yet', emptyBody: 'Messages you send will show up here.' },
  archive: { label: 'Archive', icon: (s) => <Archive size={s} />, emptyTitle: 'Archive is empty', emptyBody: 'Press e to archive a conversation: out of the inbox, never deleted.' },
  spam: { label: 'Spam', icon: (s) => <ShieldAlert size={s} />, emptyTitle: 'No spam', emptyBody: 'Suspicious mail is filtered here and removed after 30 days.' },
  trash: { label: 'Trash', icon: (s) => <Trash2 size={s} />, emptyTitle: 'Trash is empty', emptyBody: 'Deleted conversations stay here for 30 days before they are gone for good.' },
  search: { label: 'Search', icon: (s) => <Search size={s} />, emptyTitle: 'No results', emptyBody: 'Try fewer words, or operators like from:, subject:, has:attachment or is:unread.' },
  custom: { label: 'Folder', icon: (s) => <FolderIcon size={s} />, emptyTitle: 'This folder is empty', emptyBody: 'Move conversations here from the reader, or route mail here with a filter.' },
};

/** Order of system entries in the rail. `starred` is virtual. */
export const SYSTEM_ORDER: (FolderRole | 'starred')[] = ['inbox', 'starred', 'scheduled', 'drafts', 'sent', 'archive', 'spam', 'trash'];

export function folderByRole(folders: Folder[] | undefined, role: FolderRole): Folder | undefined {
  return folders?.find((f) => f.role === role);
}

export interface ResolvedView {
  /** Key used for the list query: folder id, 'starred' or 'search'. */
  listKey: string;
  role: ViewRole;
  folder: Folder | null;
  label: string;
}

/** The URL segment may be a folder id, a role name ("inbox"), `starred` or `search`. */
export function resolveView(folders: Folder[] | undefined, segment: string): ResolvedView | null {
  if (segment === 'starred') return { listKey: 'starred', role: 'starred', folder: null, label: 'Starred' };
  if (segment === 'search') return { listKey: 'search', role: 'search', folder: null, label: 'Search' };
  if (!folders) return null;
  const f = folders.find((x) => x.id === segment) ?? folders.find((x) => x.role === segment);
  if (!f) return null;
  return { listKey: f.id, role: f.role ?? 'custom', folder: f, label: f.role ? VIEW_META[f.role].label : f.name };
}
