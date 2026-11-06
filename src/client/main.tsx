import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/index.css';
import { applyPrefs } from './lib/theme';
import { App } from './App';

// Paint the cached theme before React renders, so there is no light flash in dark mode.
applyPrefs({});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registered in dev too, so Web Push can be tried on localhost.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline shell is optional */
    });
  });
  // A notification click in the service worker asks an open window to show the thread, without a reload.
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
    if (e.data?.type !== 'cirrus:navigate' || typeof e.data.url !== 'string') return;
    const url = new URL(e.data.url, location.origin);
    if (url.origin !== location.origin || url.pathname + url.search === location.pathname + location.search) return;
    history.pushState(null, '', url.pathname + url.search);
    dispatchEvent(new PopStateEvent('popstate'));
  });
}
