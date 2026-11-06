import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    resolver.current?.(false);
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const finish = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!opts}
        onClose={() => finish(false)}
        title={opts?.title ?? ''}
        description={opts?.body}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => finish(false)} data-autofocus={opts?.danger ? '' : undefined}>Cancel</Button>
            <Button variant={opts?.danger ? 'danger' : 'primary'} onClick={() => finish(true)} data-autofocus={opts?.danger ? undefined : ''}>
              {opts?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      />
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(Ctx);
  if (!fn) throw new Error('useConfirm outside ConfirmProvider');
  return fn;
}
