/** Dispatch on window to open the command palette from anywhere. */
export const OPEN_PALETTE_EVENT = 'cirrus:palette';

/** Dispatched by palette commands; the mail controller owns the targets (selection, open or focused thread). */
export const SNOOZE_EVENT = 'cirrus:snooze';
export const MUTE_EVENT = 'cirrus:mute';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The modifier glyph shown in hints: ⌘ on Apple platforms, Ctrl elsewhere. */
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl ';
