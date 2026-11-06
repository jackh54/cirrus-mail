import type { Identity, MailboxSummary } from '@shared/api';

/** Addresses a mailbox can send as. Kept apart from prefill.ts so the list and reader don't pull in DOMPurify. */
export function identitiesOf(mb: MailboxSummary): Identity[] {
  return mb.identities.length ? mb.identities : [{ email: mb.address, name: mb.displayName, isAlias: false }];
}
