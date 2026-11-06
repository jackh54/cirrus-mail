import { createElement, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  AlarmClock, AtSign, BellOff, BookUser, CalendarDays, CalendarPlus, UserPlus, MailMinus, Globe, Inbox, Keyboard, LayoutDashboard, Mail, Moon, Palette, PenLine, Search, Shield, Sparkles, Sun, Tag, User, Users,
  type LucideIcon,
} from 'lucide-react';
import { useLabels } from '../../lib/queries/labels';
import { THREAD_CATEGORIES } from '@shared/api';
import { useAiEnabled, useCategoryTabsOn } from '../../lib/queries/ai';
import { useFolders } from '../../lib/queries/mail';
import { useMeData, useUpdateMe } from '../../lib/queries/me';
import { getLastMailbox } from '../../lib/storage';
import { useCompose } from '../compose/ComposeProvider';
import { CATEGORY_LABELS, setCategoryTab } from '../mail/categoryTab';
import { SYSTEM_ORDER, VIEW_META } from '../mail/folderMeta';
import { OPEN_LABEL_PICKER_EVENT } from '../mail/labelMeta';
import { OPEN_SHORTCUTS_EVENT } from '../mail/ShortcutsOverlay';
import { MUTE_EVENT, SNOOZE_EVENT, UNSUBSCRIBE_EVENT } from './events';
import { SUMMARISE_EVENT } from '../mail/SummaryPanel';

export type Group = 'Search' | 'Actions' | 'Go to' | 'Mailboxes' | 'Settings' | 'Admin';

export interface Command {
  id: string;
  group: Group;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  keywords?: string[];
  run: () => void;
}

const icon = (I: LucideIcon) => createElement(I, { size: 16, strokeWidth: 1.75 });

/** Every palette command for the signed-in user, given the current location. */
export function useCommands(query: string): Command[] {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const compose = useCompose();
  const { user, mailboxes } = useMeData();
  const { mutate: updatePrefs } = useUpdateMe();
  const fromUrl = /^\/mail\/([^/]+)/.exec(pathname)?.[1];
  const mailbox = mailboxes.find((m) => m.id === fromUrl) ?? mailboxes.find((m) => m.id === getLastMailbox()) ?? mailboxes[0];
  const mb = mailbox?.id ?? '';
  const folders = useFolders(mb || undefined).data;
  const labels = useLabels(mb || undefined).data;
  const inMail = !!fromUrl;
  const q = query.trim();
  const aiOn = useAiEnabled();
  const tabsOn = useCategoryTabsOn();
  const threadOpen = /^\/mail\/[^/]+\/[^/]+\/[^/]+/.test(pathname);

  const base = useMemo(() => {
    const out: Command[] = [];
    if (mb) {
      out.push({ id: 'compose', group: 'Actions', label: 'Compose', icon: icon(PenLine), shortcut: 'C', keywords: ['new message', 'write', 'email'], run: () => compose.open({ mailboxId: mb, mode: 'new' }) });
      // Acts on the selection, the open conversation or the focused row, so it only makes sense in the mail view.
      if (inMail) {
        out.push({ id: 'label-as', group: 'Actions', label: 'Label as…', icon: icon(Tag), shortcut: 'L', keywords: ['label', 'tag', 'categorize'], run: () => window.dispatchEvent(new Event(OPEN_LABEL_PICKER_EVENT)) });
      }
    }
    if (mb && threadOpen) {
      out.push({ id: 'unsubscribe', group: 'Actions', label: 'Unsubscribe from this sender…', icon: icon(MailMinus), keywords: ['mailing list', 'newsletter', 'stop emails'], run: () => window.dispatchEvent(new Event(UNSUBSCRIBE_EVENT)) });
    }
    if (mb && pathname.startsWith('/mail/')) {
      out.push(
        { id: 'snooze', group: 'Actions', label: 'Snooze conversation…', icon: icon(AlarmClock), shortcut: 'B', keywords: ['later', 'remind', 'defer'], run: () => window.dispatchEvent(new Event(SNOOZE_EVENT)) },
        { id: 'mute', group: 'Actions', label: 'Mute or unmute conversation', icon: icon(BellOff), shortcut: 'M', keywords: ['silence', 'ignore', 'notifications'], run: () => window.dispatchEvent(new Event(MUTE_EVENT)) },
      );
    }
    out.push(
      { id: 'go-calendar', group: 'Go to', label: 'Go to Calendar', icon: icon(CalendarDays), keywords: ['events', 'schedule', 'agenda'], run: () => navigate('/calendar') },
      { id: 'new-event', group: 'Actions', label: 'New event', icon: icon(CalendarPlus), keywords: ['calendar', 'meeting', 'appointment', 'schedule'], run: () => navigate('/calendar?new=1') },
      { id: 'go-contacts', group: 'Go to', label: 'Go to Contacts', icon: icon(BookUser), keywords: ['address book', 'people'], run: () => navigate('/contacts') },
      { id: 'new-contact', group: 'Actions', label: 'New contact', icon: icon(UserPlus), keywords: ['address book', 'person', 'add'], run: () => navigate('/contacts/new') },
    );
    const dark = document.documentElement.classList.contains('dark');
    out.push(
      { id: 'theme', group: 'Actions', label: 'Toggle theme', icon: icon(dark ? Sun : Moon), keywords: ['dark mode', 'light mode', 'appearance'], run: () => updatePrefs({ theme: dark ? 'light' : 'dark' }) },
      { id: 'shortcuts', group: 'Actions', label: 'Keyboard shortcuts', icon: icon(Keyboard), shortcut: '?', keywords: ['help', 'keys', 'hotkeys'], run: () => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT)) },
    );
    if (mb) {
      for (const role of SYSTEM_ORDER) {
        if (role !== 'starred' && role !== 'snoozed' && !folders?.some((f) => f.role === role)) continue;
        const meta = VIEW_META[role];
        out.push({ id: `go-${role}`, group: 'Go to', label: `Go to ${meta.label}`, icon: meta.icon(16), keywords: [meta.label], run: () => navigate(`/mail/${mb}/${role}`) });
      }
      for (const f of folders?.filter((x) => !x.role) ?? []) {
        out.push({ id: `go-${f.id}`, group: 'Go to', label: `Go to ${f.name}`, icon: VIEW_META.custom.icon(16), keywords: [f.name, 'folder'], run: () => navigate(`/mail/${mb}/${f.id}`) });
      }
    }
    if (mb && tabsOn) {
      for (const c of THREAD_CATEGORIES) {
        out.push({ id: `tab-${c}`, group: 'Go to', label: `Inbox: ${CATEGORY_LABELS[c]} tab`, icon: icon(Inbox), keywords: ['inbox', 'tab', 'category', CATEGORY_LABELS[c]], run: () => { setCategoryTab(c); navigate(`/mail/${mb}/inbox`); } });
      }
    }
    if (mb && aiOn && threadOpen) {
      out.push({ id: 'summarise', group: 'Actions', label: 'Summarise conversation', icon: icon(Sparkles), keywords: ['ai', 'summary', 'tldr'], run: () => window.dispatchEvent(new Event(SUMMARISE_EVENT)) });
    }
    if (mb) {
      for (const l of labels ?? []) {
        out.push({ id: `go-label-${l.id}`, group: 'Go to', label: `Go to label ${l.name}`, icon: icon(Tag), keywords: [l.name, 'label', 'tag'], run: () => navigate(`/mail/${mb}/label:${l.id}`) });
      }
    }
    if (mailboxes.length > 1) {
      for (const m of mailboxes) {
        if (m.id === mb) continue;
        out.push({ id: `mb-${m.id}`, group: 'Mailboxes', label: `Switch to ${m.address}`, icon: icon(Mail), keywords: [m.displayName, 'mailbox'], run: () => navigate(`/mail/${m.id}/inbox`) });
      }
    }
    const settings: [string, string, LucideIcon][] = [['profile', 'Profile', User], ['security', 'Security', Shield], ['mailbox', 'Mailbox', Inbox], ['appearance', 'Appearance', Palette]];
    for (const [path, label, I] of settings) {
      out.push({ id: `set-${path}`, group: 'Settings', label: `${label} settings`, icon: icon(I), keywords: ['settings', 'preferences', label, ...(path === 'security' ? ['passkey', 'password', '2fa'] : [])], run: () => navigate(`/settings/${path}`) });
    }
    if (user.role === 'admin') {
      const admin: [string, string, LucideIcon][] = [['', 'Overview', LayoutDashboard], ['users', 'Users', Users], ['domains', 'Domains', Globe], ['mailboxes', 'Mailboxes', Inbox], ['aliases', 'Aliases', AtSign]];
      for (const [path, label, I] of admin) {
        out.push({ id: `admin-${path || 'overview'}`, group: 'Admin', label: `Admin: ${label}`, icon: icon(I), keywords: ['admin', label], run: () => navigate(path ? `/admin/${path}` : '/admin') });
      }
    }
    return out;
  }, [mb, pathname, folders, labels, inMail, mailboxes, user.role, compose, navigate, updatePrefs, aiOn, tabsOn, threadOpen]);

  return useMemo(() => {
    if (!q || !mb) return base;
    const search: Command = {
      id: 'search',
      group: 'Search',
      label: `Search mail for “${q}”`,
      icon: icon(Search),
      shortcut: '/',
      run: () => navigate(`/mail/${mb}/search?q=${encodeURIComponent(q)}`),
    };
    return [search, ...base];
  }, [base, q, mb, navigate]);
}
