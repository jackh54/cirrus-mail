import { X } from 'lucide-react';
import type { AdminUser } from '@shared/api';
import { IconButton } from '../../components/Button';
import { Select } from '../../components/Field';

export interface Member { userId: string; role: 'owner' | 'member' }

export function MembersEditor({ users, value, onChange }: { users: AdminUser[]; value: Member[]; onChange: (v: Member[]) => void }) {
  const available = users.filter((u) => !value.some((m) => m.userId === u.id) && !u.disabled);
  return (
    <div>
      <ul className="mb-2 divide-y divide-border rounded-lg border border-border">
        {value.map((m) => {
          const u = users.find((x) => x.id === m.userId);
          return (
            <li key={m.userId} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{u?.name ?? 'Unknown user'}</p>
                <p className="truncate text-xs text-muted">{u?.email}</p>
              </div>
              <Select
                aria-label={`Role for ${u?.name ?? 'user'}`}
                value={m.role}
                className="h-8 w-28"
                onChange={(e) => onChange(value.map((x) => (x.userId === m.userId ? { ...x, role: e.target.value === 'owner' ? 'owner' : 'member' } : x)))}
              >
                <option value="owner">Owner</option>
                <option value="member">Member</option>
              </Select>
              <IconButton label={`Remove ${u?.name ?? 'member'}`} size="sm" onClick={() => onChange(value.filter((x) => x.userId !== m.userId))}>
                <X size={14} />
              </IconButton>
            </li>
          );
        })}
        {!value.length && <li className="px-3 py-2 text-[13px] text-faint">No members. Nobody can open this mailbox.</li>}
      </ul>
      {available.length > 0 && (
        <Select
          aria-label="Add member"
          value=""
          onChange={(e) => e.target.value && onChange([...value, { userId: e.target.value, role: value.length ? 'member' : 'owner' }])}
        >
          <option value="">Add a member…</option>
          {available.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
        </Select>
      )}
    </div>
  );
}
