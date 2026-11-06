import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { setUnauthorizedHandler } from './lib/api';
import { queryClient } from './lib/queryClient';
import { FullScreenSpinner } from './components/Spinner';
import { AppShell } from './features/auth/AppShell';
import { HomeRedirect } from './features/auth/HomeRedirect';
import { LoginPage } from './features/auth/LoginPage';
import { SetupPage } from './features/auth/SetupPage';
import { NotFound, RouteError } from './features/auth/NotFound';
import { MailPage } from './features/mail/MailPage';

const SettingsRoutes = lazy(() => import('./features/settings/SettingsRoutes'));
const AdminRoutes = lazy(() => import('./features/admin/AdminRoutes'));

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<FullScreenSpinner />}>{children}</Suspense>;
}

export const router = createBrowserRouter([
  { path: '/setup', element: <SetupPage />, errorElement: <RouteError /> },
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: 'mail', element: <HomeRedirect /> },
      { path: 'mail/:mailboxId', element: <Navigate to="inbox" replace /> },
      { path: 'mail/:mailboxId/:folder/:threadId?', element: <MailPage /> },
      { path: 'settings/*', element: <Lazy><SettingsRoutes /></Lazy> },
      { path: 'admin/*', element: <Lazy><AdminRoutes /></Lazy> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

setUnauthorizedHandler(() => {
  const here = location.pathname + location.search;
  if (location.pathname.startsWith('/login') || location.pathname.startsWith('/setup')) return;
  queryClient.clear();
  void router.navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
});
