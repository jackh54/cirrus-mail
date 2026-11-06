import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, Menu as MenuIcon, Pencil, Plus, Search, Trash2, UserPlus, Users, Mail as MailIcon } from 'lucide-react';
import type { Address, ContactInput, ContactView } from '@shared/api';
import { AppSidebar } from '../../components/AppSidebar';
import { Avatar } from '../../components/Avatar';
import { Button, IconButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Drawer } from '../../components/Drawer';
import { EmptyState } from '../../components/EmptyState';
import { Input } from '../../components/Field';
import { Skeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useContactMutations, useContacts } from '../../lib/queries/dav';
import { useMeData } from '../../lib/queries/me';
import { getLastMailbox } from '../../lib/storage';
import { useCompose } from '../compose/ComposeProvider';
import { useLayoutMode } from '../mail/useMailRoute';
import { ContactForm, emailTypeLabel, phoneTypeLabel } from './ContactForm';

const asAddress = (c: ContactView): Address => ({ name: c.fn, email: c.emails[0]?.value ?? '' });

const EMPTY: ContactInput = { fn: '', emails: [], phones: [], org: '', note: '' };

/** First letter for grouping; anything that is not a letter goes under "#". */
function groupOf(name: string): string {
  const c = name.trim().normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

export function ContactsPage() {
  const { contactId } = useParams();
  const layout = useLayoutMode();
  const mobile = layout === 'mobile';
  const [drawer, setDrawer] = useState(false);
  const contacts = useContacts();
  const [q, setQ] = useState('');
  const isNew = contactId === 'new';
  const selected = isNew ? undefined : contacts.data?.find((c) => c.id === contactId);

  useEffect(() => {
    document.title = 'Contacts - Cirrus Mail';
    return () => {
      document.title = 'Cirrus Mail';
    };
  }, []);

  const showList = layout === 'wide' || !contactId;
  const showDetail = layout === 'wide' || !!contactId;

  const sidebar = <AppSidebar label="Contacts" onNavigate={mobile ? () => setDrawer(false) : undefined} />;
  return (
    <div className="flex h-full bg-bg">
      {mobile ? <Drawer open={drawer} onClose={() => setDrawer(false)} label="Apps">{sidebar}</Drawer> : sidebar}
      {showList && (
        <ContactList
          contacts={contacts.data}
          loading={contacts.isPending}
          error={contacts.isError ? errorMessage(contacts.error) : null}
          q={q}
          onQ={setQ}
          activeId={contactId}
          onOpenMenu={mobile ? () => setDrawer(true) : undefined}
          className={layout === 'wide' ? 'w-[340px] shrink-0 border-r border-border' : 'min-w-0 flex-1'}
        />
      )}
      {showDetail && (
        <main className="min-w-0 flex-1 overflow-y-auto" aria-label="Contact">
          {isNew ? (
            <NewContact key="new" />
          ) : selected ? (
            <ContactDetail key={selected.id} contact={selected} back={layout !== 'wide'} />
          ) : contactId && contacts.isPending ? (
            <div className="p-6"><Skeleton className="h-6 w-48" /></div>
          ) : contactId ? (
            <EmptyState icon={<Users />} title="Contact not found" action={<Link to="/contacts" className="text-[13px] font-medium text-selected-fg hover:underline">Back to contacts</Link>} />
          ) : (
            <EmptyState icon={<Users />} title="Select a contact" body="Pick someone from the list, or add a new contact." />
          )}
        </main>
      )}
    </div>
  );
}

function ContactList({ contacts, loading, error, q, onQ, activeId, onOpenMenu, className }: {
  contacts: ContactView[] | undefined; loading: boolean; error: string | null; q: string; onQ: (v: string) => void; activeId: string | undefined; onOpenMenu?: () => void; className?: string;
}) {
  const navigate = useNavigate();
  const search = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hits = (contacts ?? []).filter((c) => !needle || c.fn.toLowerCase().includes(needle) || c.org.toLowerCase().includes(needle) || c.emails.some((e) => e.value.toLowerCase().includes(needle)) || c.phones.some((p) => p.value.includes(needle)));
    const map = new Map<string, ContactView[]>();
    for (const c of hits) {
      const g = groupOf(c.fn);
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
  }, [contacts, q]);

  return (
    <section aria-label="Contact list" className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3 pointer-coarse:h-14">
        {onOpenMenu && <IconButton label="Menu" size="md" onClick={onOpenMenu}><MenuIcon size={18} /></IconButton>}
        <div className="relative min-w-0 flex-1">
          <Search size={14} strokeWidth={1.75} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input ref={search} type="search" aria-label="Search contacts" placeholder="Search contacts" value={q} onChange={(e) => onQ(e.target.value)} className="pl-8" />
        </div>
        <IconButton label="New contact" size="md" onClick={() => navigate('/contacts/new')}><Plus size={18} /></IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <EmptyState icon={<Users />} title="Couldn't load contacts" body={error} />
        ) : loading ? (
          <ul aria-label="Loading">
            {Array.from({ length: 8 }, (_, i) => (
              <li key={i} className="flex h-14 items-center gap-3 px-4"><Skeleton className="size-8 rounded-full" /><Skeleton className="h-3 w-32" /></li>
            ))}
          </ul>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={q ? 'No matches' : 'No contacts yet'}
            body={q ? 'Try another name or address.' : 'Contacts you add here also sync to your phone over CardDAV.'}
            action={!q && <Button variant="primary" icon={<UserPlus size={14} />} onClick={() => navigate('/contacts/new')}>New contact</Button>}
          />
        ) : (
          groups.map(([letter, items]) => (
            <section key={letter} aria-labelledby={`g-${letter === '#' ? 'other' : letter}`}>
              <h2 id={`g-${letter === '#' ? 'other' : letter}`} className="sticky top-0 z-10 h-6 border-b border-border bg-sidebar px-4 text-[12px] leading-6 font-medium text-faint">{letter}</h2>
              <ul>
                {items.map((c) => (
                  <li key={c.id}>
                    <Link
                      to={`/contacts/${c.id}`}
                      aria-current={c.id === activeId ? 'true' : undefined}
                      className={cn('flex h-14 items-center gap-3 border-b border-border px-4 hover:bg-hover', c.id === activeId && 'bg-primary-soft hover:bg-primary-soft')}
                    >
                      <Avatar address={asAddress(c)} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] leading-5 font-medium text-fg">{c.fn}</span>
                        <span className="block truncate text-[12px] leading-4 text-muted">{c.emails[0]?.value || c.org || c.phones[0]?.value || ' '}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </section>
  );
}

function Header({ title, back, children }: { title: string; back: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex h-12 items-center gap-1 border-b border-border px-3 pointer-coarse:h-14">
      {back && (
        <Link to="/contacts" aria-label="Back to contacts" className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"><ArrowLeft size={18} strokeWidth={1.75} /></Link>
      )}
      <h1 className="min-w-0 flex-1 truncate px-1 text-[14px] font-semibold">{title}</h1>
      {children}
    </div>
  );
}

function NewContact() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { create } = useContactMutations();
  const layout = useLayoutMode();
  const initial: ContactInput = { ...EMPTY, fn: sp.get('name') ?? '', emails: sp.get('email') ? [{ value: sp.get('email')!, types: [] }] : [] };
  return (
    <>
      <Header title="New contact" back={layout !== 'wide'} />
      <div className="mx-auto max-w-[560px] px-4 py-6 sm:px-8">
        <ContactForm
          initial={initial}
          saving={create.isPending}
          submitLabel="Add contact"
          onCancel={() => navigate('/contacts')}
          onSubmit={(c) => create.mutate(c, {
            onSuccess: (made) => navigate(`/contacts/${made.id}`, { replace: true }),
            onError: (e) => toast({ tone: 'error', title: "Couldn't add the contact", description: errorMessage(e) }),
          })}
        />
      </div>
    </>
  );
}

function ContactDetail({ contact: c, back }: { contact: ContactView; back: boolean }) {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const compose = useCompose();
  const { mailboxes } = useMeData();
  const { update, remove } = useContactMutations();
  const editing = sp.get('edit') === '1';
  const mailbox = mailboxes.find((m) => m.id === getLastMailbox()) ?? mailboxes[0];
  const stop = () => setSp({}, { replace: true });
  const pending = c.id.startsWith('tmp-');

  if (editing) {
    return (
      <>
        <Header title="Edit contact" back={back} />
        <div className="mx-auto max-w-[560px] px-4 py-6 sm:px-8">
          <ContactForm
            initial={{ fn: c.fn, org: c.org, note: c.note, emails: c.emails, phones: c.phones }}
            saving={false}
            submitLabel="Save"
            onCancel={stop}
            onSubmit={(next) => {
              update.mutate({ id: c.id, ...next }, { onError: (e) => toast({ tone: 'error', title: "Couldn't save the contact", description: errorMessage(e) }) });
              stop();
            }}
          />
        </div>
      </>
    );
  }

  const emailTo = (email: string) => mailbox && compose.open({ mailboxId: mailbox.id, mode: 'new', to: [{ email, name: c.fn }] });
  return (
    <>
      <Header title={c.fn} back={back}>
        {mailbox && c.emails[0] && <Button size="sm" icon={<MailIcon size={14} />} onClick={() => emailTo(c.emails[0].value)}>Email</Button>}
        <IconButton label="Edit contact" disabled={pending} onClick={() => setSp({ edit: '1' }, { replace: true })}><Pencil size={16} /></IconButton>
        <IconButton
          label="Delete contact"
          disabled={pending}
          onClick={async () => {
            if (!(await confirm({ title: `Delete ${c.fn}?`, body: 'This also removes the contact from devices that sync with Cirrus.', confirmLabel: 'Delete', danger: true }))) return;
            remove.mutate(c.id, { onError: (e) => toast({ tone: 'error', title: "Couldn't delete the contact", description: errorMessage(e) }) });
            navigate('/contacts', { replace: true });
          }}
        >
          <Trash2 size={16} />
        </IconButton>
      </Header>
      <div className="mx-auto max-w-[560px] px-4 py-6 sm:px-8">
        <div className="mb-6 flex items-center gap-4">
          <Avatar address={asAddress(c)} size={56} />
          <div className="min-w-0">
            <p className="truncate text-[18px] leading-6 font-semibold tracking-[-0.01em]">{c.fn}</p>
            {c.org && <p className="truncate text-[13px] text-muted">{c.org}</p>}
          </div>
        </div>
        <dl className="divide-y divide-border border-y border-border">
          {c.emails.map((e, i) => (
            <Row key={`e${i}`} label={emailTypeLabel(e.types) || 'Email'}>
              <button type="button" disabled={!mailbox} onClick={() => emailTo(e.value)} className="break-all text-left text-selected-fg hover:underline disabled:text-fg">{e.value}</button>
            </Row>
          ))}
          {c.phones.map((p, i) => (
            <Row key={`p${i}`} label={phoneTypeLabel(p.types) || 'Phone'}>
              <a href={`tel:${p.value.replace(/[^\d+*#,;]/g, '')}`} className="text-selected-fg hover:underline">{p.value}</a>
            </Row>
          ))}
          {c.note && <Row label="Notes"><span className="whitespace-pre-wrap">{c.note}</span></Row>}
        </dl>
        {!c.emails.length && !c.phones.length && !c.note && <p className="mt-4 text-[13px] text-muted">Nothing else saved for this contact.</p>}
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-3 py-3 text-[13px] leading-5">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </div>
  );
}
