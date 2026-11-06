import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../lib/cn';

type Tone = 'neutral' | 'success' | 'error';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: Tone;
  /** ms; 0 keeps it until dismissed. Default 4000 (errors 7000). */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Show a draining progress bar (used by undo send). */
  progress?: boolean;
}

interface ToastItem extends ToastOptions { id: number }

interface ToastApi {
  toast: (o: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), []);
  const toast = useCallback((o: ToastOptions) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { ...o, id }]);
    return id;
  }, []);
  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-3 md:bottom-4 md:left-4 md:right-auto md:items-start md:px-0"
      >
        {items.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const tone = item.tone ?? 'neutral';
  const duration = item.duration ?? (tone === 'error' ? 7000 : 4000);
  useEffect(() => {
    if (!duration) return;
    const t = setTimeout(onDismiss, duration);
    return () => clearTimeout(t);
  }, [duration, onDismiss]);

  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? AlertTriangle : Info;
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto relative w-full max-w-[360px] overflow-hidden rounded-[10px] bg-elevated shadow-pop animate-pop-in"
    >
      <div className="flex min-h-10 items-start gap-2.5 py-2.5 pr-2 pl-3">
        <Icon
          size={15}
          strokeWidth={1.75}
          className={cn('mt-[2.5px] shrink-0', tone === 'success' && 'text-success', tone === 'error' && 'text-danger', tone === 'neutral' && 'text-muted')}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-5 font-medium text-fg">{item.title}</p>
          {item.description && <p className="text-[12px] leading-4 text-muted">{item.description}</p>}
        </div>
        {item.action && (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              onDismiss();
            }}
            className="-my-0.5 h-6 shrink-0 rounded-md px-2 text-[13px] font-medium text-selected-fg hover:bg-primary-soft"
          >
            {item.action.label}
          </button>
        )}
        <button type="button" aria-label="Dismiss" onClick={onDismiss} className="-my-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg">
          <X size={14} />
        </button>
      </div>
      {item.progress && duration > 0 && (
        <div
          className="absolute bottom-0 left-0 h-0.5 bg-primary"
          style={{ animation: `cm-drain ${duration}ms linear forwards` }}
        />
      )}
    </div>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast outside ToastProvider');
  return v;
}
