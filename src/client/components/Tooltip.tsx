import { useId, type ReactNode } from 'react';

/** Hover/focus tooltip for rich, non-button content. The wrapper is focusable so keyboard users get it too. */
export function Tooltip({ content, children, label }: { content: ReactNode; children: ReactNode; label: string }) {
  const id = useId();
  return (
    <span className="group/tt relative inline-flex rounded" tabIndex={0} aria-label={label} aria-describedby={id}>
      {children}
      <span
        role="tooltip"
        id={id}
        className="pointer-events-none invisible absolute top-full left-1/2 z-50 mt-1.5 w-max max-w-64 -translate-x-1/2 rounded-md bg-tooltip px-2 py-1.5 text-[12px] leading-4 font-normal text-tooltip-fg opacity-0 shadow-pop transition-opacity duration-100 ease-out group-hover/tt:visible group-hover/tt:opacity-100 group-focus-visible/tt:visible group-focus-visible/tt:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}
