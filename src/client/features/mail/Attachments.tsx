import { useState } from 'react';
import { Download } from 'lucide-react';
import type { Attachment } from '@shared/api';
import { Dialog } from '../../components/Dialog';
import { formatBytes } from '../../lib/format';
import { FileTypeIcon } from './FileTypeIcon';

function inlineUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}inline=1`;
}

export function Attachments({ items }: { items: Attachment[] }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  const visible = items.filter((a) => !(a.inline && a.contentId));
  if (!visible.length) return null;
  return (
    <>
      <ul className="mt-4 flex flex-wrap gap-2" aria-label="Attachments">
        {visible.map((a) => {
          const isImage = a.mimeType.startsWith('image/');
          return (
            <li key={a.id} className="group flex max-w-72 items-center overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-border-strong">
              {isImage ? (
                <button type="button" onClick={() => setPreview(a)} className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2.5 text-left" aria-label={`Preview ${a.filename}`}>
                  <img src={inlineUrl(a.url)} alt="" className="size-8 shrink-0 rounded object-cover" loading="lazy" />
                  <Label a={a} />
                </button>
              ) : (
                <a href={a.url} download={a.filename} className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2.5">
                  <FileTypeIcon mime={a.mimeType} size={18} />
                  <Label a={a} />
                </a>
              )}
              <a href={a.url} download={a.filename} aria-label={`Download ${a.filename}`} title="Download" className="mx-1 rounded-md p-1.5 text-faint hover:bg-hover hover:text-fg">
                <Download size={15} />
              </a>
            </li>
          );
        })}
      </ul>
      <Dialog open={!!preview} onClose={() => setPreview(null)} title={preview?.filename ?? ''} width={1000}>
        {preview && (
          <div className="flex flex-col items-center gap-3">
            <img src={inlineUrl(preview.url)} alt={preview.filename} className="max-h-[72vh] max-w-full rounded-lg object-contain" />
            <a href={preview.url} download={preview.filename} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
              <Download size={14} /> Download · {formatBytes(preview.size)}
            </a>
          </div>
        )}
      </Dialog>
    </>
  );
}

function Label({ a }: { a: Attachment }) {
  return (
    <span className="min-w-0 pr-1">
      <span className="block truncate text-[13px] text-fg">{a.filename}</span>
      <span className="block text-[11.5px] text-faint">{formatBytes(a.size)}</span>
    </span>
  );
}
