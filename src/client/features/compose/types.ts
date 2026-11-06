import type { Address, Attachment, ComposeMode, DraftInput } from '@shared/api';

/** Client-side state of one compose sheet. */
export interface ComposeDraft {
  key: string;
  mailboxId: string;
  draftId: string | null;
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  parentId: string | null;
  composeMode: ComposeMode;
  attachments: Attachment[];
}

export function toDraftInput(d: ComposeDraft): DraftInput {
  return {
    from: d.from,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    html: d.html,
    parentId: d.parentId,
    composeMode: d.composeMode,
  };
}
