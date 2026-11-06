import { Navigate, Route, Routes } from 'react-router';
import { Bell, Inbox, Palette, Shield, User } from 'lucide-react';
import { PageShell } from '../../components/PageShell';
import { AppearanceSettings } from './AppearanceSettings';
import { MailboxSettingsPage } from './MailboxSettingsPage';
import { NotificationsSettings } from './NotificationsSettings';
import { ProfileSettings } from './ProfileSettings';
import { SecuritySettings } from './SecuritySettings';

const NAV = [
  { to: '/settings/profile', label: 'Profile', icon: <User size={16} /> },
  { to: '/settings/security', label: 'Security', icon: <Shield size={16} /> },
  { to: '/settings/mailbox', label: 'Mailbox', icon: <Inbox size={16} /> },
  { to: '/settings/notifications', label: 'Notifications', icon: <Bell size={16} /> },
  { to: '/settings/appearance', label: 'Appearance', icon: <Palette size={16} /> },
];

export default function SettingsRoutes() {
  return (
    <PageShell title="Settings" nav={NAV}>
      <Routes>
        <Route index element={<Navigate to="profile" replace />} />
        <Route path="profile" element={<ProfileSettings />} />
        <Route path="security" element={<SecuritySettings />} />
        <Route path="mailbox" element={<MailboxSettingsPage />} />
        <Route path="notifications" element={<NotificationsSettings />} />
        <Route path="appearance" element={<AppearanceSettings />} />
        <Route path="*" element={<Navigate to="profile" replace />} />
      </Routes>
    </PageShell>
  );
}
