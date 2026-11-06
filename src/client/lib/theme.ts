import type { Density, Theme } from '@shared/api';

const KEY = 'cirrus:prefs';

interface Prefs { theme: Theme; density: Density }

export function cachedPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      return {
        theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system',
        density: p.density === 'compact' ? 'compact' : 'comfortable',
      };
    }
  } catch {
    /* storage unavailable: fall through to defaults */
  }
  return { theme: 'system', density: 'comfortable' };
}

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
let current: Prefs = cachedPrefs();

function paint(): void {
  const dark = current.theme === 'dark' || (current.theme === 'system' && !!darkQuery?.matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.dataset.density = current.density;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0E1424' : '#F7F8FC');
}

darkQuery?.addEventListener('change', () => {
  if (current.theme === 'system') paint();
});

/** Apply theme + density to <html> and remember them for the next cold start. */
export function applyPrefs(p: Partial<Prefs>): void {
  current = { ...current, ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore quota or privacy-mode errors */
  }
  paint();
}

export function currentDensity(): Density {
  return current.density;
}
