import { useState } from 'react';
import { Filter as FilterIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Filter, FilterInput } from '@shared/api';
import { Button, IconButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Switch } from '../../components/Field';
import { Section } from '../../components/PageShell';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { useFolders } from '../../lib/queries/mail';
import { useFilterMutations, useFilters } from '../../lib/queries/settings';
import { describeFilter, FilterEditor } from './FilterEditor';

export function FiltersSection({ mb }: { mb: string }) {
  const filters = useFilters(mb);
  const folders = useFolders(mb);
  const { create, update, remove } = useFilterMutations(mb);
  const confirm = useConfirm();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Filter | 'new' | null>(null);
  const list = [...(filters.data ?? [])].sort((a, b) => a.sort - b.sort);
  const onError = (e: unknown) => toast({ tone: 'error', title: 'Filter not saved', description: errorMessage(e) });

  const save = (input: FilterInput) => {
    const done = { onSuccess: () => setEditing(null), onError };
    if (editing && editing !== 'new') update.mutate({ ...input, id: editing.id }, done);
    else create.mutate({ ...input, sort: list.length ? Math.max(...list.map((f) => f.sort)) + 1 : 0 }, done);
  };

  return (
    <Section
      title="Filters"
      description="Rules run in order on incoming mail, before it reaches your inbox."
      footer={<Button icon={<Plus size={14} />} onClick={() => setEditing('new')}>New filter</Button>}
    >
      {list.length ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {list.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2.5">
              <Switch checked={f.enabled} label={`${f.name} enabled`} onChange={(enabled) => update.mutate({ ...f, enabled }, { onError })} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{f.name}</p>
                <p className="truncate text-[12px] text-muted">{describeFilter(f, folders.data ?? [])}</p>
              </div>
              <IconButton label={`Edit ${f.name}`} size="sm" onClick={() => setEditing(f)}><Pencil size={14} /></IconButton>
              <IconButton
                label={`Delete ${f.name}`}
                size="sm"
                onClick={async () => {
                  if (await confirm({ title: `Delete filter "${f.name}"?`, confirmLabel: 'Delete', danger: true })) remove.mutate(f.id, { onError });
                }}
              >
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-[13px] text-faint">
          <FilterIcon size={14} /> {filters.isPending ? 'Loading…' : 'No filters yet.'}
        </p>
      )}
      {editing && (
        <FilterEditor
          initial={editing === 'new' ? null : editing}
          folders={folders.data ?? []}
          saving={create.isPending || update.isPending}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}
    </Section>
  );
}
