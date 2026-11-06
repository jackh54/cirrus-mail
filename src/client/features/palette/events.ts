/** Dispatch on window to open the command palette from anywhere. */
export const OPEN_PALETTE_EVENT = 'cirrus:palette';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The modifier glyph shown in hints: ⌘ on Apple platforms, Ctrl elsewhere. */
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl ';
