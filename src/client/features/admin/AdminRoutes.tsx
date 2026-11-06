import { Navigate, Route, Routes } from 'react-router';
import { AtSign, Globe, Inbox, LayoutDashboard, Users } from 'lucide-react';
import { PageShell } from '../../components/PageShell';
import { useMeData } from '../../lib/queries/me';
import { AliasesPage } from './AliasesPage';
import { DomainsPage } from './DomainsPage';
import { MailboxesPage } from './MailboxesPage';
import { OverviewPage } from './OverviewPage';
import { UsersPage } from './UsersPage';

const NAV = [
  { to: '/admin', label: 'Overview', icon: <LayoutDashboard size={16} />, end: true },
  { to: '/admin/users', label: 'Users', icon: <Users size={16} /> },
  { to: '/admin/domains', label: 'Domains', icon: <Globe size={16} /> },
  { to: '/admin/mailboxes', label: 'Mailboxes', icon: <Inbox size={16} /> },
  { to: '/admin/aliases', label: 'Aliases', icon: <AtSign size={16} /> },
];

export default function AdminRoutes() {
  const { user } = useMeData();
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return (
    <PageShell title="Admin" nav={NAV}>
      <Routes>
        <Route index element={<OverviewPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="domains" element={<DomainsPage />} />
        <Route path="mailboxes" element={<MailboxesPage />} />
        <Route path="aliases" element={<AliasesPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </PageShell>
  );
}
