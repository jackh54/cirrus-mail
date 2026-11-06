import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export const inputClass =
  'w-full rounded-md border border-border-strong bg-bg px-2.5 text-[13px] text-fg placeholder:text-faint transition-[border-color,box-shadow] duration-100 ease-out ' +
  'focus:border-primary focus:outline-none focus:shadow-[0_0_0_3px_rgb(43_99_232/0.16)] disabled:opacity-60 ' +
  'aria-invalid:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(inputClass, 'h-8', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cn(inputClass, 'min-h-24 py-1.5 leading-5', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cn(inputClass, 'h-8 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

/** Label + control + hint/error. The child receives the generated id via render prop. */
export function Field({
  label, hint, error, children, className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-[13px] leading-5 font-medium text-fg">
        {label}
      </label>
      {children(id, hint || error ? descId : undefined)}
      {error ? (
        <p id={descId} className="text-[12px] leading-4 text-danger">{error}</p>
      ) : hint ? (
        <p id={descId} className="text-[12px] leading-4 text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked, onChange, label, disabled,
}: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors duration-100 ease-out disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-border-strong',
      )}
    >
      <span
        className={cn(
          'inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform duration-100 ease-out',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
