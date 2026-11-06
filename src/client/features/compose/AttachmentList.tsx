import { Paperclip, X } from 'lucide-react';
import type { Attachment } from '@shared/api';
import { formatBytes } from '../../lib/format';
import { FileTypeIcon } from '../mail/FileTypeIcon';

export interface Upload {
  id: string;
  name: string;
  size: number;
  progress: number;
  error?: string;
}

export function AttachmentList({
  attachments, uploads, onRemove, onDismissUpload,
}: {
  attachments: Attachment[];
  uploads: Upload[];
  onRemove: (a: Attachment) => void;
  onDismissUpload: (id: string) => void;
}) {
  if (!attachments.length && !uploads.length) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-4 pb-2" aria-label="Attachments">
      {attachments.map((a) => (
        <li key={a.id} className="flex max-w-60 items-center gap-2 rounded-md border border-border h-8 pr-1 pl-2 text-[13px]">
          <FileTypeIcon mime={a.mimeType} size={15} />
          <span className="min-w-0 flex-1 truncate">{a.filename}</span>
          <span className="tnum shrink-0 text-[12px] text-faint">{formatBytes(a.size)}</span>
          <button type="button" aria-label={`Remove ${a.filename}`} onClick={() => onRemove(a)} className="rounded p-0.5 text-faint hover:bg-hover hover:text-fg">
            <X size={13} />
          </button>
        </li>
      ))}
      {uploads.map((u) => (
        <li
          key={u.id}
          className={`relative flex max-w-60 items-center gap-2 overflow-hidden rounded-md border h-8 pr-1 pl-2 text-[13px] ${u.error ? 'border-danger/40 bg-danger-soft text-danger' : 'border-border'}`}
        >
          <Paperclip size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{u.error ? `${u.name}: ${u.error}` : u.name}</span>
          {!u.error && <span className="tnum shrink-0 text-[12px] text-faint">{Math.round(u.progress * 100)}%</span>}
          {u.error && (
            <button type="button" aria-label="Dismiss" onClick={() => onDismissUpload(u.id)} className="rounded p-0.5 hover:bg-hover">
              <X size={13} />
            </button>
          )}
          {!u.error && (
            <span
              className="absolute bottom-0 left-0 h-0.5 bg-primary transition-[width] duration-150"
              style={{ width: `${u.progress * 100}%` }}
              role="progressbar"
              aria-label={`Uploading ${u.name}`}
              aria-valuenow={Math.round(u.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
