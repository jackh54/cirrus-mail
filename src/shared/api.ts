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
  /** Push notifications show the sender and subject (true) or only "New mail" and the mailbox address. */
  pushPreview: boolean;
  /** Show the Primary/Updates/Promotions/Social/Forums tabs on the Inbox (only when an admin has turned AI triage on). */
  categoryTabs: boolean;
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
export interface LoginInput { email: string; password: string; totp?: string; passkey?: PasskeyAssertionJSON }
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
export interface UpdateMeInput { name?: string; theme?: Theme; density?: Density; pushPreview?: boolean; categoryTabs?: boolean }
export interface ChangePasswordInput { current: string; next: string }
export interface TotpBeginResponse { secret: string; otpauthUrl: string }
export interface TotpEnableResponse { recoveryCodes: string[] }

// ---------- passkeys (WebAuthn) ----------

export interface PasskeyInfo { id: ID; name: string; createdAt: Millis; lastUsedAt: Millis | null }
/** PublicKeyCredentialCreationOptionsJSON / RequestOptionsJSON as the server builds them (binary fields base64url). */
export interface PasskeyOptionsResponse { options: Record<string, unknown> }
export interface PasskeyAttestationJSON {
  id: string; rawId: string; type: 'public-key';
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}
export interface PasskeyAssertionJSON {
  id: string; rawId: string; type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
}
export interface PasskeyRegisterInput { credential: PasskeyAttestationJSON; name?: string }

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

export const THREAD_CATEGORIES = ['primary', 'updates', 'promotions', 'social', 'forums'] as const;
export type ThreadCategory = (typeof THREAD_CATEGORIES)[number];

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
  snoozedUntil: Millis | null;  // hidden from the Inbox until then (listed under Snoozed)
  muted: boolean;               // new messages skip the Inbox (Archive, read, no push)
  /** Inbox tab the thread belongs to. Always 'primary' while AI triage is off or a thread has not been classified. */
  category: ThreadCategory;
  labels: ID[];                 // labels carried by at least one message of this thread (see Label)
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
  /** How this message can be unsubscribed from; null unless it carried List-Unsubscribe and passed aligned authentication. */
  unsubscribe: UnsubscribeInfo | null;
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
  | 'spam' | 'not_spam' | 'move' | 'delete_forever'
  | 'snooze' | 'unsnooze' | 'mute' | 'unmute';

export interface ThreadActionInput {
  threadIds: ID[];
  action: ThreadAction;
  folderId?: ID;                // required for 'move'
  until?: Millis;               // required for 'snooze': a future time, at most a year away
}

// ---------- labels ----------

/** The fixed label palette (cobalt/graphite friendly). The client maps each name to a colour token. */
export const LABEL_COLORS = ['cobalt', 'sky', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'violet', 'graphite'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export const LABEL_LIMITS = { maxPerMailbox: 100, maxName: 40 } as const;

/** Labels are per mailbox; names are unique ignoring case. `unread` counts unread messages with the label outside Trash and Spam. */
export interface Label {
  id: ID;
  name: string;
  color: LabelColor;
  unread: number;
}

export interface LabelInput { name: string; color: LabelColor }

/**
 * POST /api/mailboxes/:mb/threads/labels: adds and/or removes labels on every message of the given threads.
 * An unknown thread or label id is a 404 and nothing is written.
 */
export interface ThreadLabelsInput {
  threadIds: ID[];
  add?: ID[];
  remove?: ID[];
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
  | { type: 'apply_label'; labelId: ID }
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

// ---------- web push ----------

/** GET /api/push/public-key: the VAPID key for `pushManager.subscribe({ applicationServerKey })`. */
export interface PushPublicKeyResponse { publicKey: string } // base64url, uncompressed P-256

/** POST /api/push/subscriptions: the browser's `PushSubscription.toJSON()`. */
export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/** DELETE /api/push/subscriptions */
export interface PushUnsubscribeInput { endpoint: string }

/** GET /api/push/subscriptions: the caller's own devices. */
export interface PushDevice {
  id: ID;
  userAgent: string | null;
  createdAt: Millis;
  lastSuccessAt: Millis | null;
}

/** POST /api/push/test */
export interface PushTestResponse { sent: number; failed: number }

/** The decrypted push message the service worker receives. */
export interface PushPayload {
  type: 'mail' | 'test';
  mailboxId?: ID;
  threadId?: ID;
  title: string;
  body: string;
  tag: string;
}

// ---------- admin ----------

export interface AdminUser extends User {
  disabled: boolean;
  mailboxCount: number;
  /** Set while the user has not accepted their invite yet (they cannot sign in until they do). */
  invite: InviteStatus | null;
}

export interface InviteStatus {
  sentAt: Millis | null;        // last time the invite email went out (null: never emailed, link only)
  expiresAt: Millis;            // expired invites stay listed so the admin can resend them
}

// ---------- invites ----------

/**
 * POST /api/admin/users/invite: creates the user (no usable password) plus an optional mailbox, and emails
 * a one-time link to their sign-in email. The link is also returned so the admin can share it by hand.
 */
export interface AdminInviteInput {
  name: string;
  email: string;                // sign-in email: must be an address the person can already read
  role: Role;
  mailbox?: { localPart: string; domainId: ID };
  /** Existing mailboxes (shared ones like support@) to add them to, with their role in each. Max 50. */
  joinMailboxes?: { mailboxId: ID; role: 'owner' | 'member' }[];
  /** false = create the link only, don't email it. Default true. */
  send?: boolean;
}

/** Why the invite email did not go out (the user and link still exist). */
export type InviteEmailSkip =
  | 'NOT_REQUESTED'             // send: false
  | 'HOSTED_HERE'               // the sign-in email is on a domain this Cirrus hosts, so they can't read it yet
  | 'NO_SENDING_DOMAIN'         // no domain has been added yet, so there is nothing to send from
  | 'SEND_FAILED';              // Email Sending rejected it (see `error`)

export interface AdminInviteResponse {
  user: AdminUser;
  inviteUrl: string;            // https://<host>/invite#<token>, valid until user.invite.expiresAt
  email: { sent: true; from: string } | { sent: false; reason: InviteEmailSkip; error?: string };
}

/** POST /api/admin/users/:id/invite (resend) takes `{ send?: boolean }`, issues a new link (the old one stops working) and returns AdminInviteResponse. */
export interface AdminResendInviteInput { send?: boolean }

/** POST /api/invites/lookup (public): what the accept page shows. The token travels in the body, never in a URL. */
export interface InviteLookupInput { token: string }
export interface InviteLookupResponse {
  email: string;
  name: string;
  inviterName: string | null;
  mailboxAddresses: string[];   // every mailbox they belong to, sorted by address
  expiresAt: Millis;
}

/** POST /api/invites/accept (public): sets the password, consumes the invite and signs the user in. */
export interface InviteAcceptInput { token: string; name: string; password: string }
// response: AuthResponse

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

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
  /** The admin-set daily limit (see SendingStatus), so the Overview can show sentToday against it. */
  dailySendLimit: number | null;
}

// ---------- AI triage (optional, off by default) ----------

/** GET /api/ai/status (any signed-in user): whether the Inbox tabs and Summarise exist at all. */
export interface AiStatus { enabled: boolean }

/** GET /api/mailboxes/:mb/categories: threads with unread mail in the Inbox, per tab. */
export interface CategoryCounts { unread: Record<ThreadCategory, number> }

/** PUT /api/mailboxes/:mb/threads/:tid/category. `rememberSender` makes the thread's latest sender always land in that tab. */
export interface SetCategoryInput { category: ThreadCategory; rememberSender?: boolean }

/** GET/POST /api/mailboxes/:mb/threads/:tid/summary. GET returns null when nothing fresh is cached; POST generates (or returns the cache). */
export interface ThreadSummaryResult {
  bullets: string[];
  generatedAt: Millis;
  cached: boolean;
}
export interface ThreadSummaryResponse { summary: ThreadSummaryResult | null }

/** GET/PATCH /api/admin/ai */
export interface AdminAi {
  enabled: boolean;
  dailyBudget: number;          // AI calls per UTC day; classification stops silently and Summarise errors at the cap
  usedToday: number;
  /** false when this deploy has no AI binding (the toggle can still be saved, but nothing runs). */
  available: boolean;
}
export interface AdminAiPatch { enabled?: boolean; dailyBudget?: number } // dailyBudget: 0..100,000

export const AI_DEFAULT_DAILY_BUDGET = 500;

// ---------- sending quota ----------

/**
 * GET /api/sending (any signed-in user): today's outbound count against the daily limit.
 * Cloudflare doesn't expose the account's quota, so an admin types it in (it differs per account and grows
 * over time). Counted per UTC day, one per recipient, across everything Cirrus sends through Email Sending:
 * mail, invites and auto-replies. Forwards to verified addresses are free and not counted.
 */
export interface SendingStatus {
  dailyLimit: number | null;    // null = not set: show the count without a limit
  sentToday: number;
  dayStartsAt: Millis;          // 00:00 UTC today
}

/** Share of the daily limit at which the UI starts warning. */
export const SEND_WARN_RATIO = 0.8;

/** GET/PATCH /api/admin/settings */
export interface AdminSettings { dailySendLimit: number | null } // PATCH: 1..1,000,000, or null to clear

// ---------- unsubscribe ----------

/** What the reader needs to offer "Unsubscribe". The action itself only takes a message id. */
export interface UnsubscribeInfo {
  /** one_click: the server POSTs; mailto: the server sends the email; link: the browser opens `url`. */
  method: 'one_click' | 'mailto' | 'link';
  host: string;                 // hostname of the https URL, or the domain of the mailto address, for the confirmation
  url: string | null;           // https only; opened by the browser for `link`
}

/** POST /api/mailboxes/:mb/messages/:id/unsubscribe */
export interface UnsubscribeInput { blockSender?: boolean }
export interface UnsubscribeResponse {
  method: UnsubscribeInfo['method'];
  /** one_click and mailto: whether the request or the email went out. link: always true (the browser opens it). */
  ok: boolean;
  blocked: boolean;
  url: string | null;
}

// ---------- reply templates ----------

/** GET/POST /api/mailboxes/:mb/templates, PATCH/DELETE /api/mailboxes/:mb/templates/:id. Shared by the mailbox's members. */
export interface ReplyTemplate {
  id: ID;
  name: string;
  subject: string;              // optional: fills an empty subject
  bodyHtml: string;             // sanitised on the way in
  updatedAt: Millis;
}
export interface ReplyTemplateInput { name: string; subject: string; bodyHtml: string }

// ---------- limits shared by both sides ----------

export const MAX_TEMPLATES_PER_MAILBOX = 100;
export const MAX_SNOOZE_MS = 366 * 24 * 3600 * 1000;


export const LIMITS = {
  maxRecipients: 50,
  maxMessageBytes: 25 * 1024 * 1024,
  maxAttachments: 32,
  maxSubject: 998,
  pollIntervalMs: 30_000,
  undoSendMs: 5_000,
} as const;
