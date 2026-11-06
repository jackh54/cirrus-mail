import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '../lib/cn';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'bg-primary-fill text-primary-fg hover:bg-primary-fill-hover',
  secondary: 'bg-bg text-fg border border-border-strong hover:bg-hover',
  ghost: 'text-muted hover:bg-hover hover:text-fg',
  subtle: 'bg-surface-2 text-fg hover:bg-hover',
  danger: 'bg-danger text-white hover:opacity-90',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[13px] gap-1.5',
  md: 'h-8 px-3 text-[13px] gap-1.5',
  lg: 'h-9 px-4 text-[13px] gap-2',
};

// cm-hit: a 44px minimum hit area on touch screens (styles/index.css), without changing the look.
const base =
  'cm-hit inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap select-none ' +
  'transition-colors duration-100 ease-out disabled:opacity-50 [&_svg]:shrink-0';

export function buttonClass(variant: Variant = 'secondary', size: Size = 'md', className?: string): string {
  return cn(base, variants[variant], sizes[size], className);
}

/** A router link styled as a button (avoids nesting a <button> inside an <a>). */
export function LinkButton({
  variant, size, className, icon, children, ...rest
}: LinkProps & { variant?: Variant; size?: Size; icon?: ReactNode }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={buttonClass(variant, size, className)}
      {...rest}
    >
      {loading ? <Spinner size={14} /> : icon}
      {children}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  /** Shown in the tooltip after the label, e.g. "E" gives "Archive  E". */
  shortcut?: string;
  /** `sm` is the 28px default; `md` (32px) is for touch targets such as the mobile header. */
  size?: 'sm' | 'md';
  active?: boolean;
  tipSide?: 'top' | 'bottom';
  tipAlign?: 'start' | 'center' | 'end';
  /** Skip the tooltip (e.g. inside menus or when a visible label already exists). */
  noTip?: boolean;
}

/** Tooltip text for an action and its shortcut, used by IconButton and other .cm-tip elements. */
export function tipText(label: string, shortcut?: string): string {
  return shortcut ? `${label}  ${shortcut}` : label;
}

/** Square icon-only button: 28px, radius 6, hover token. `label` becomes aria-label and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, size = 'sm', active, tipSide, tipAlign, noTip, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      data-tip={noTip ? undefined : tipText(label, shortcut)}
      data-tip-side={tipSide}
      data-tip-align={tipAlign === 'center' ? undefined : tipAlign}
      className={cn(
        'cm-hit inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-colors duration-100 ease-out',
        'hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:stroke-[1.75]',
        !noTip && 'cm-tip',
        active && 'text-primary',
        size === 'sm' ? 'size-7' : 'size-8',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
