import type { FolderRole } from '../shared/api';
import type { UserRow } from './lib/db';

export interface MailboxCtx {
  id: string;
  address: string;
  displayName: string;
  role: 'owner' | 'member';
  /** System folder ids by role, loaded with the membership check. */
  roles: Record<FolderRole, string>;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow;
    sessionId: string;
    mailbox: MailboxCtx;
  };
};
