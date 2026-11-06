// Shared API contract between the Worker (src/worker) and the client (src/client).
// docs/design.md §5 lists the routes. Change this file first, then both sides.

export type ID = string;
export type Millis = number;

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Address {
  email: string;
  name?: string;
}

// ---------- users & auth ----------

export type Role = 'admin' | 'member';
export type Theme = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

export interface User {
  id: ID;
  email: string;
  name: string;
  role: Role;
  totpEnabled: boolean;
  theme: Theme;
  density: Density;
  mustChangePassword: boolean;
  createdAt: Millis;
}

export interface SessionInfo {
  id: ID;
  userAgent: string | null;
  createdAt: Millis;
  lastSeenAt: Millis;
  current: boolean;
}

export interface SetupStatus { needsSetup: boolean }
export interface SetupInput { token: string; name: string; email: string; password: string }
export interface LoginInput { email: string; password: string; totp?: string }
export interface AuthResponse { user: User }

export interface MailboxSummary {
  id: ID;
  address: string;
  displayName: string;
  role: 'owner' | 'member';
  unread: number;               // inbox unread
  identities: Identity[];       // addresses this user may send as from this mailbox
}

export interface Identity {
  email: string;
  name: string;
  isAlias: boolean;
}

export interface MeResponse { user: User; mailboxes: MailboxSummary[] }
export interface UpdateMeInput { name?: string; theme?: Theme; density?: Density }
export interface ChangePasswordInput { current: string; next: string }
export interface TotpBeginResponse { secret: string; otpauthUrl: string }
export interface TotpEnableResponse { recoveryCodes: string[] }

// ---------- mail ----------

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'spam' | 'trash' | 'scheduled';

export interface Folder {
  id: ID;
  name: string;
  role: FolderRole | null;
  sort: number;
  unread: number;
  total: number;
}

export interface ThreadSummary {
  id: ID;
  subject: string;
  snippet: string;
  participants: Address[];
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
  isStarred: boolean;
  lastMessageAt: Millis;
  folderIds: ID[];              // folders that contain at least one message of this thread
}

export type MessageStatus = 'received' | 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';
export type ComposeMode = 'new' | 'reply' | 'reply_all' | 'forward';

export interface Attachment {
  id: ID;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
  url: string;                  // signed /api/files/... URL (valid ~1h)
}

export interface AuthResults {
  spf?: string;                 // pass | fail | softfail | neutral | none
  dkim?: string;
  dmarc?: string;
  /** A DMARC or DKIM pass for the visible From domain. Missing (older messages) means not verified. */
  aligned?: boolean;
}

export interface MessageFull {
  id: ID;
  threadId: ID;
  folderId: ID;
  direction: 'in' | 'out';
  status: MessageStatus;
  messageIdHeader: string | null;
  parentId: ID | null;
  composeMode: ComposeMode | null;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: string | null;
  subject: string;
  snippet: string;
  html: string | null;          // raw (unsanitised) HTML. The client MUST sanitise and sandbox it.
  text: string | null;
  attachments: Attachment[];
  isRead: boolean;
  isStarred: boolean;
  spamScore: number;
  auth: AuthResults | null;
  listId: string | null;
  sendAt: Millis | null;
  sentAt: Millis | null;
  errorCode: string | null;
  errorMessage: string | null;
  date: Millis;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: MessageFull[];
}

export type ThreadAction =
  | 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'trash'
  | 'spam' | 'not_spam' | 'move' | 'delete_forever';

export interface ThreadActionInput {
  threadIds: ID[];
  action: ThreadAction;
  folderId?: ID;                // required for 'move'
}

export interface DraftInput {
  from: string;                 // identity email
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  text?: string;                // derived by the server from html when omitted
  parentId?: ID | null;         // message being replied to / forwarded
  composeMode?: ComposeMode;
}

export interface SendInput { sendAt?: Millis }
export interface SendResponse { message: MessageFull; status: 'sent' | 'scheduled' }

export interface Contact {
  email: string;
  name: string;
}

export interface AutoreplySettings {
  enabled: boolean;
  subject: string;
  body: string;                 // plain text
  start: Millis | null;
  end: Millis | null;
}

export interface MailboxSettings {
  displayName: string;
  signatureHtml: string;
  autoreply: AutoreplySettings;
}

export type FilterField = 'from' | 'to' | 'subject' | 'has_attachment' | 'list_id';
export type FilterOp = 'contains' | 'equals' | 'ends_with' | 'regex' | 'is_true';

export interface FilterCondition {
  field: FilterField;
  op: FilterOp;
  value: string;
}

export type FilterAction =
  | { type: 'move_to'; folderId: ID }
  | { type: 'mark_read' }
  | { type: 'star' }
  | { type: 'delete' }
  | { type: 'forward_to'; email: string };

export interface Filter {
  id: ID;
  name: string;
  match: 'all' | 'any';
  conditions: FilterCondition[];
  actions: FilterAction[];
  enabled: boolean;
  sort: number;
}

export type FilterInput = Omit<Filter, 'id'>;

export interface BlockedSender { id: ID; pattern: string; createdAt: Millis }

export interface PollResponse { newCount: number; latest: ThreadSummary[] }

/** POST /api/proxy/sign: the client asks for signed proxy URLs for remote images (max 200 urls). */
export interface ProxySignInput { urls: string[] }
export interface ProxySignResponse { signed: Record<string, string> } // original url -> /api/proxy/image?u=..&s=..

// ---------- admin ----------

export interface AdminUser extends User {
  disabled: boolean;
  mailboxCount: number;
}

export interface AdminCreateUserInput {
  name: string;
  email: string;
  role: Role;
  tempPassword: string;
  /** Optionally create a mailbox for the user in one go */
  mailbox?: { localPart: string; domainId: ID };
}

export interface AdminUpdateUserInput {
  name?: string;
  role?: Role;
  disabled?: boolean;
  resetPassword?: string;       // sets must_change_password
}

export interface Domain {
  id: ID;
  name: string;
  catchAllMailboxId: ID | null;
  mailboxCount: number;
  createdAt: Millis;
}

export interface DomainCheck {
  domain: string;
  mx: { ok: boolean; records: string[] };
  spf: { ok: boolean; record: string | null };
  dmarc: { ok: boolean; record: string | null };
  dkim: { ok: boolean | null; note: string };
}

export interface AdminMailbox {
  id: ID;
  address: string;
  displayName: string;
  domainId: ID;
  members: { userId: ID; name: string; email: string; role: 'owner' | 'member' }[];
  messageCount: number;
  createdAt: Millis;
}

export interface AdminMailboxInput {
  localPart: string;
  domainId: ID;
  displayName: string;
  members: { userId: ID; role: 'owner' | 'member' }[];
}

export interface Alias {
  id: ID;
  address: string;
  mailboxId: ID;
  mailboxAddress: string;
  canSend: boolean;
  createdAt: Millis;
}

export interface AdminStats {
  users: number;
  mailboxes: number;
  domains: number;
  messages: number;
  storageBytes: number;
  sentToday: number;
  sent30d: number;
  received30d: number;
  rejected30d: number;
  sendErrors30d: number;
  daily: { day: string; sent: number; received: number }[]; // last 14 days, YYYY-MM-DD
}

// ---------- limits shared by both sides ----------

export const LIMITS = {
  maxRecipients: 50,
  maxMessageBytes: 25 * 1024 * 1024,
  maxAttachments: 32,
  maxSubject: 998,
  pollIntervalMs: 30_000,
  undoSendMs: 5_000,
} as const;
