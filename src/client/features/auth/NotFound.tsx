import { useRouteError } from 'react-router';
import { Compass, TriangleAlert } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { Button, LinkButton } from '../../components/Button';

export function NotFound() {
  return (
    <EmptyState
      icon={<Compass size={24} />}
      title="Nothing here"
      body="That page does not exist, or it moved."
      action={<LinkButton to="/" variant="primary">Back to mail</LinkButton>}
    />
  );
}

export function RouteError() {
  const err = useRouteError();
  const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<TriangleAlert size={24} />}
        title="Something went wrong"
        body={message}
        action={<Button variant="primary" onClick={() => location.reload()}>Reload</Button>}
      />
    </div>
  );
}
