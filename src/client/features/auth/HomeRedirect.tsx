import { Navigate } from 'react-router';
import { Inbox } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { LinkButton } from '../../components/Button';
import { useMeData } from '../../lib/queries/me';
import { getLastMailbox } from '../../lib/storage';

export function HomeRedirect() {
  const { user, mailboxes } = useMeData();
  const last = getLastMailbox();
  const target = mailboxes.find((m) => m.id === last) ?? mailboxes[0];
  if (target) return <Navigate to={`/mail/${target.id}/inbox`} replace />;
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<Inbox size={24} />}
        title="No mailbox yet"
        body={
          user.role === 'admin'
            ? 'Add a domain and create a mailbox for yourself to start receiving mail.'
            : 'An administrator needs to give you access to a mailbox.'
        }
        action={
          user.role === 'admin' ? (
            <LinkButton to="/admin/domains" variant="primary">Open admin</LinkButton>
          ) : (
            <LinkButton to="/settings/profile">Settings</LinkButton>
          )
        }
      />
    </div>
  );
}
