import { useEffect } from 'react';
import { Link, Outlet } from 'react-router';
import { KeyRound, WifiOff } from 'lucide-react';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { FullScreenSpinner } from '../../components/Spinner';
import { isApiError } from '../../lib/api';
import { useMe } from '../../lib/queries/me';
import { applyPrefs } from '../../lib/theme';
import { ComposeProvider } from '../compose/ComposeProvider';
import { ShortcutsOverlay } from '../mail/ShortcutsOverlay';
import { PaletteHost } from '../palette/PaletteHost';

/** Everything behind login. Loads /api/me once; a 401 is redirected to /login by the API layer. */
export function AppShell() {
  const me = useMe();
  const user = me.data?.user;

  useEffect(() => {
    if (user) applyPrefs({ theme: user.theme, density: user.density });
  }, [user?.theme, user?.density, user]);

  if (me.isPending || (me.isError && isApiError(me.error) && me.error.status === 401)) return <FullScreenSpinner />;
  if (me.isError) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<WifiOff size={24} />}
          title="Can't reach Cirrus"
          body={me.error.message}
          action={<Button variant="primary" onClick={() => void me.refetch()}>Try again</Button>}
        />
      </div>
    );
  }

  return (
    <ComposeProvider>
      <div className="flex h-full flex-col">
        {user?.mustChangePassword && (
          <div className="flex h-9 items-center justify-center gap-2 border-b border-border bg-warning-soft px-4 text-[13px] text-warning">
            <KeyRound size={14} />
            <span>You signed in with a temporary password.</span>
            <Link to="/settings/security" className="font-medium underline underline-offset-2">Choose a new one</Link>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
      <ShortcutsOverlay />
      <PaletteHost />
    </ComposeProvider>
  );
}
