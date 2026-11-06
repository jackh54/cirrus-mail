import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { setUnauthorizedHandler } from './lib/api';
import { queryClient } from './lib/queryClient';
import { FullScreenSpinner } from './components/Spinner';
import { AppShell } from './features/auth/AppShell';
import { HomeRedirect } from './features/auth/HomeRedirect';
import { NotFound, RouteError } from './features/auth/NotFound';

// Declarative routes (not the data router) keep react-router's share of the entry chunk small.
// Every screen is its own chunk; the mail chunk starts downloading at boot, in parallel with /api/me.
const loadMail = () => import('./features/mail/MailPage');
const loadAuth = () => import('./features/auth/authPages');
const MailPage = lazy(() => loadMail().then((m) => ({ default: m.MailPage })));
const LoginPage = lazy(() => loadAuth().then((m) => ({ default: m.LoginPage })));
const SetupPage = lazy(() => loadAuth().then((m) => ({ default: m.SetupPage })));
const InvitePage = lazy(() => loadAuth().then((m) => ({ default: m.InvitePage })));
const SettingsRoutes = lazy(() => import('./features/settings/SettingsRoutes'));
const AdminRoutes = lazy(() => import('./features/admin/AdminRoutes'));

if (typeof location !== 'undefined') {
  if (location.pathname.startsWith('/login') || location.pathname.startsWith('/setup') || location.pathname.startsWith('/invite')) void loadAuth();
  else void loadMail();
}

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<FullScreenSpinner />}>{children}</Suspense>;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  override render() {
    return this.state.error ? <RouteError error={this.state.error} /> : this.props.children;
  }
}

/** Lets the API layer redirect to /login on a 401 without a full reload. */
function UnauthorizedRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      const here = location.pathname + location.search;
      if (location.pathname.startsWith('/login') || location.pathname.startsWith('/setup') || location.pathname.startsWith('/invite')) return;
      queryClient.clear();
      void navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
    });
  }, [navigate]);
  return null;
}

export function AppRoutes() {
  const { pathname } = useLocation();
  // Keyed by the top-level section so an error screen clears when the user navigates away.
  const section = pathname.split('/')[1] ?? '';
  return (
    <ErrorBoundary key={section}>
      <UnauthorizedRedirect />
      <Routes>
        <Route path="/setup" element={<Lazy><SetupPage /></Lazy>} />
        <Route path="/login" element={<Lazy><LoginPage /></Lazy>} />
        <Route path="/invite" element={<Lazy><InvitePage /></Lazy>} />
        <Route path="/" element={<AppShell />}>
          <Route index element={<HomeRedirect />} />
          <Route path="mail" element={<HomeRedirect />} />
          <Route path="mail/:mailboxId" element={<Navigate to="inbox" replace />} />
          <Route path="mail/:mailboxId/:folder/:threadId?" element={<Lazy><MailPage /></Lazy>} />
          <Route path="settings/*" element={<Lazy><SettingsRoutes /></Lazy>} />
          <Route path="admin/*" element={<Lazy><AdminRoutes /></Lazy>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  );
}
