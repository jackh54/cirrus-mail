import type { UserRow } from './lib/db';

export interface MailboxCtx {
  id: string;
  address: string;
  displayName: string;
  role: 'owner' | 'member';
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UserRow;
    sessionId: string;
    mailbox: MailboxCtx;
  };
};
