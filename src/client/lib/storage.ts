const LAST_MAILBOX = 'cirrus:lastMailbox';

export function getLastMailbox(): string | null {
  try {
    return localStorage.getItem(LAST_MAILBOX);
  } catch {
    return null;
  }
}

export function setLastMailbox(id: string): void {
  try {
    localStorage.setItem(LAST_MAILBOX, id);
  } catch {
    /* ignore */
  }
}
