import { useLayoutEffect, useRef, type RefObject } from 'react';

/** A ref that always holds the latest value, for stable callbacks that read fresh state. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
