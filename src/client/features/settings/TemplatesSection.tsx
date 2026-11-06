import { useState } from 'react';
import { FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { MAX_TEMPLATES_PER_MAILBOX, type ReplyTemplate } from '@shared/api';
import { Button, IconButton } from '../../components/Button';
import { useConfirm } from '../../components/Confirm';
import { Dialog } from '../../components/Dialog';
import { Field, Input } from '../../components/Field';
import { Section } from '../../components/PageShell';
import { useToast } from '../../components/Toast';
import { errorMessage } from '../../lib/api';
import { useTemplateMutations, useTemplates } from '../../lib/queries/templates';
import { RichEditor } from '../compose/RichEditor';

/** Reply templates for one mailbox. Every member of a shared mailbox sees and edits the same ones. */
export function TemplatesSection({ mb }: { mb: string }) {
  const templates = useTemplates(mb);
  const { remove } = useTemplateMutations(mb);
  const confirm = useConfirm();
  const { toast } = useToast();
  // null: closed; 'new': blank; otherwise the template being edited.
  const [editing, setEditing] = useState<ReplyTemplate | 'new' | null>(null);
  const list = templates.data ?? [];

  const del = async (t: ReplyTemplate) => {
    if (!(await confirm({ title: `Delete “${t.name}”?`, body: 'Everyone with access to this mailbox loses this template.', confirmLabel: 'Delete', danger: true }))) return;
    remove.mutate(t.id, { onError: (e) => toast({ tone: 'error', title: 'Not deleted', description: errorMessage(e) }) });
  };

  return (
    <Section
      title="Reply templates"
      description="Canned responses you can insert while writing. Shared with everyone who has access to this mailbox."
      footer={
        <Button icon={<Plus size={14} />} disabled={list.length >= MAX_TEMPLATES_PER_MAILBOX} onClick={() => setEditing('new')}>New template</Button>
      }
    >
      {list.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {list.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2">
              <FileText size={15} strokeWidth={1.75} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{t.name}</span>
                {t.subject && <span className="block truncate text-[12px] text-muted">{t.subject}</span>}
              </span>
              <IconButton label={`Edit ${t.name}`} size="sm" onClick={() => setEditing(t)}><Pencil size={14} /></IconButton>
              <IconButton label={`Delete ${t.name}`} size="sm" onClick={() => void del(t)}><Trash2 size={14} /></IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-faint">{templates.isPending ? 'Loading…' : 'No templates yet.'}</p>
      )}
      {editing && <TemplateDialog mb={mb} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Section>
  );
}

function TemplateDialog({ mb, template, onClose }: { mb: string; template: ReplyTemplate | null; onClose: () => void }) {
  const { create, update } = useTemplateMutations(mb);
  const { toast } = useToast();
  const [name, setName] = useState(template?.name ?? '');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [html, setHtml] = useState(template?.bodyHtml ?? '');
  const busy = create.isPending || update.isPending;

  const save = () => {
    const input = { name: name.trim(), subject: subject.trim(), bodyHtml: html };
    const opts = {
      onSuccess: () => {
        toast({ tone: 'success', title: 'Template saved' });
        onClose();
      },
      onError: (e: unknown) => toast({ tone: 'error', title: 'Not saved', description: errorMessage(e) }),
    };
    if (template) update.mutate({ id: template.id, ...input }, opts);
    else create.mutate(input, opts);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={template ? 'Edit template' : 'New template'}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" hint="Shown in the Insert template menu.">
          {(id, d) => <Input id={id} aria-describedby={d} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Subject" hint="Optional. Fills the subject when it is empty.">
          {(id, d) => <Input id={id} aria-describedby={d} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />}
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium">Message</p>
          <div className="overflow-hidden rounded-md border border-border focus-within:border-primary focus-within:ring-3 focus-within:ring-ring/30">
            <RichEditor
              initialHtml={template?.bodyHtml ?? ''}
              onChange={setHtml}
              placeholder="Write the reply…"
              toolbarPosition="top"
              className="[&_.cm-prose]:min-h-40 [&_[role=toolbar]]:border-b [&_[role=toolbar]]:border-border"
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
