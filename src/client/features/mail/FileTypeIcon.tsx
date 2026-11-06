import { File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation } from 'lucide-react';

export function FileTypeIcon({ mime, size = 16 }: { mime: string; size?: number }) {
  const m = mime.toLowerCase();
  const cls = 'shrink-0 text-muted';
  if (m.startsWith('image/')) return <FileImage size={size} className={cls} />;
  if (m.startsWith('video/')) return <FileVideo size={size} className={cls} />;
  if (m.startsWith('audio/')) return <FileAudio size={size} className={cls} />;
  if (/zip|compressed|tar|gzip|7z|rar/.test(m)) return <FileArchive size={size} className={cls} />;
  if (/sheet|excel|csv/.test(m)) return <FileSpreadsheet size={size} className={cls} />;
  if (/presentation|powerpoint|keynote/.test(m)) return <Presentation size={size} className={cls} />;
  if (/pdf|text|word|document|rtf/.test(m)) return <FileText size={size} className={cls} />;
  return <File size={size} className={cls} />;
}
