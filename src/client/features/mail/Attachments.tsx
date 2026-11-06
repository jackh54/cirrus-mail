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
            <li key={a.id} className="group flex h-11 max-w-72 items-center overflow-hidden rounded-md border border-border hover:bg-hover">
              {isImage ? (
                <button type="button" onClick={() => setPreview(a)} className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2.5 text-left" aria-label={`Preview ${a.filename}`}>
                  <img src={inlineUrl(a.url)} alt="" className="size-7 shrink-0 rounded-[4px] object-cover" loading="lazy" />
                  <Label a={a} />
                </button>
              ) : (
                <a href={a.url} download={a.filename} className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2.5">
                  <FileTypeIcon mime={a.mimeType} size={18} />
                  <Label a={a} />
                </a>
              )}
              <a href={a.url} download={a.filename} aria-label={`Download ${a.filename}`} title="Download" className="mx-1 inline-flex size-7 items-center justify-center rounded-md text-faint hover:bg-black/5 hover:text-fg dark:hover:bg-white/8">
                <Download size={16} strokeWidth={1.75} />
              </a>
            </li>
          );
        })}
      </ul>
      <Dialog open={!!preview} onClose={() => setPreview(null)} title={preview?.filename ?? ''} width={1000}>
        {preview && (
          <div className="flex flex-col items-center gap-3">
            <img src={inlineUrl(preview.url)} alt={preview.filename} className="max-h-[72vh] max-w-full rounded-lg object-contain" />
            <a href={preview.url} download={preview.filename} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-selected-fg hover:underline">
              <Download size={14} strokeWidth={1.75} /> Download ({formatBytes(preview.size)})
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
      <span className="block truncate text-[13px] leading-4 text-fg">{a.filename}</span>
      <span className="tnum block text-[12px] leading-4 text-faint">{formatBytes(a.size)}</span>
    </span>
  );
}
