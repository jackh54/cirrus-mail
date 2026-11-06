import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import type { MboxImport } from '@shared/api';
import { Button, buttonClass } from '../../components/Button';
import { Field, Select } from '../../components/Field';
import { Section } from '../../components/PageShell';
import { useToast } from '../../components/Toast';
import { ApiError, api, errorMessage } from '../../lib/api';
import { qk } from '../../lib/queries/keys';
import { useLabels } from '../../lib/queries/labels';
import { useFolders } from '../../lib/queries/mail';
import { putPart, useMboxImport } from '../../lib/queries/mbox';

const RETRIES = 4;

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Bar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-surface-2">
      <div className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out" style={{ width: `${pct}%` }} />
    </div>
  );
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
  });

export function MboxSection({ mb }: { mb: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [folderId, setFolderId] = useState('');
  const [markRead, setMarkRead] = useState(true);
  const [sent, setSent] = useState<number | null>(null); // bytes uploaded by this tab; null when not uploading here
  const abort = useRef<AbortController | null>(null);
  const [exportScope, setExportScope] = useState('mailbox');
  const imp = useMboxImport(mb, sent !== null);
  const folders = useFolders(mb);
  const labels = useLabels(mb);
  const cur = imp.data ?? null;

  const refresh = () => qc.invalidateQueries({ queryKey: qk.mboxImport(mb) });
  const base = `/api/mailboxes/${mb}/import`;

  /** Sends the parts that are not stored yet, one at a time with retries, then completes the upload. */
  const run = async (i: MboxImport, f: File) => {
    const ctl = new AbortController();
    abort.current = ctl;
    const total = Math.ceil(i.size / i.partSize);
    const have = new Set(i.uploadedParts);
    let done = 0;
    for (let n = 1; n <= total; n++) if (have.has(n)) done += Math.min(i.partSize, i.size - (n - 1) * i.partSize);
    setSent(done);
    try {
      for (let n = 1; n <= total; n++) {
        if (have.has(n)) continue;
        const part = f.slice((n - 1) * i.partSize, n * i.partSize);
        for (let attempt = 1; ; attempt++) {
          try {
            await putPart(`${base}/${i.id}/parts/${n}`, part, (loaded) => setSent(done + loaded), ctl.signal);
            break;
          } catch (e) {
            const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429);
            if (!retryable || attempt >= RETRIES) throw e;
            await wait(1000 * attempt, ctl.signal);
          }
        }
        done += part.size;
        setSent(done);
      }
      await api.post(`${base}/${i.id}/complete`);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        toast({ tone: 'error', title: 'Upload stopped', description: `${errorMessage(e)} Choose the same file again to resume.` });
      }
    } finally {
      abort.current = null;
      setSent(null);
      await refresh();
    }
  };

  const start = async () => {
    if (!file) return;
    try {
      const i = await api.post<MboxImport>(base, { filename: file.name, size: file.size, folderId: folderId || undefined, markRead });
      await refresh();
      void run(i, file);
    } catch (e) {
      toast({ tone: 'error', title: 'Could not start the import', description: errorMessage(e) });
    }
  };

  const cancel = async () => {
    abort.current?.abort();
    if (!cur) return;
    try {
      await api.del(`${base}/${cur.id}`);
    } catch (e) {
      toast({ tone: 'error', title: 'Could not cancel', description: errorMessage(e) });
    }
    await refresh();
  };

  const picker = (
    <input
      type="file"
      accept=".mbox,.mbx,application/mbox,application/octet-stream"
      aria-label="mbox file"
      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      className="block w-full text-[13px] text-muted file:mr-3 file:h-8 file:rounded-md file:border file:border-border-strong file:bg-bg file:px-3 file:text-[13px] file:font-medium file:text-fg hover:file:bg-hover"
    />
  );

  const uploading = cur?.status === 'uploading';
  const processing = cur?.status === 'processing';
  const finished = cur && !uploading && !processing;
  const sameFile = !!file && !!cur && file.name === cur.filename && file.size === cur.size;
  const targets = (folders.data ?? []).filter((f) => f.role !== 'drafts' && f.role !== 'scheduled');

  return (
    <>
      <Section
        title="Import mail"
        description="Bring mail in from a Google Takeout, Apple Mail or Thunderbird .mbox file (up to 20 GB). Gmail labels become folders, stars and labels. Messages you already have are skipped."
      >
        {(!cur || finished) && (
          <div className="space-y-4">
            {finished && (
              <div className="rounded-md border border-border px-3 py-2.5 text-[13px]" role="status">
                <p className="font-medium">
                  {cur.status === 'done' ? 'Import finished' : cur.status === 'cancelled' ? 'Import cancelled' : 'Import failed'}
                  <span className="font-normal text-muted"> · {cur.filename}</span>
                </p>
                <p className="mt-0.5 text-muted">
                  {cur.imported.toLocaleString()} imported, {cur.duplicates.toLocaleString()} already there, {cur.skipped.toLocaleString()} skipped
                  {cur.errors > 0 && `, ${cur.errors.toLocaleString()} could not be read`}.
                </p>
                {cur.errorSamples.length > 0 && <p className="mt-0.5 text-[12px] text-faint">{cur.errorSamples.slice(0, 3).join('; ')}</p>}
              </div>
            )}
            <Field label="File">{() => picker}</Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Folder for mail without Gmail labels" hint="Gmail files sort themselves by label.">
                {(id, d) => (
                  <Select id={id} aria-describedby={d} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                    <option value="">Archive</option>
                    {targets.filter((f) => f.role !== 'archive').map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </Select>
                )}
              </Field>
              <label className="flex items-center gap-2 text-[13px] sm:self-end sm:pb-1.5">
                <input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} className="size-4 accent-[var(--color-primary)]" />
                Mark everything as read
              </label>
            </div>
            <Button variant="primary" icon={<Upload size={14} />} disabled={!file} onClick={() => void start()}>Start import</Button>
          </div>
        )}

        {uploading && cur && (
          <div className="space-y-3" role="status">
            <p className="text-[13px]">
              Uploading <span className="font-medium">{cur.filename}</span> ({size(cur.size)})
            </p>
            {sent !== null ? (
              <>
                <Bar value={sent / cur.size} label="Upload progress" />
                <p className="text-[12px] text-muted">{size(sent)} of {size(cur.size)}. Keep this page open until the upload finishes.</p>
              </>
            ) : (
              <>
                <Bar value={(cur.uploadedParts.length * cur.partSize) / cur.size} label="Upload progress" />
                <p className="text-[12px] text-muted">The upload was interrupted. Choose the same file to continue where it stopped.</p>
                {picker}
                {file && !sameFile && <p className="text-[12px] text-danger">That is not the file being uploaded ({cur.filename}, {size(cur.size)}).</p>}
              </>
            )}
            <div className="flex gap-2">
              {sent === null && <Button variant="primary" disabled={!sameFile} onClick={() => void run(cur, file!)}>Resume upload</Button>}
              <Button onClick={() => void cancel()}>Cancel import</Button>
            </div>
          </div>
        )}

        {processing && cur && (
          <div className="space-y-3" role="status">
            <p className="text-[13px]">
              Importing <span className="font-medium">{cur.filename}</span>. You can leave this page; it continues in the background.
            </p>
            <Bar value={cur.bytesProcessed / cur.size} label="Import progress" />
            <p className="text-[12px] text-muted">
              {Math.floor((cur.bytesProcessed / cur.size) * 100)}% · {cur.imported.toLocaleString()} imported, {cur.duplicates.toLocaleString()} already there, {cur.skipped.toLocaleString()} skipped
              {cur.errors > 0 && `, ${cur.errors.toLocaleString()} unreadable`}
            </p>
            <Button onClick={() => void cancel()}>Cancel import</Button>
            <p className="text-[12px] text-faint">Cancelling keeps the mail that was already imported.</p>
          </div>
        )}
      </Section>

      <Section title="Export mail" description="Download a folder, a label or the whole mailbox as an .mbox file that other mail apps can import.">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="What to export" className="sm:w-72">
            {(id) => (
              <Select id={id} value={exportScope} onChange={(e) => setExportScope(e.target.value)}>
                <option value="mailbox">Whole mailbox</option>
                <optgroup label="Folders">
                  {targets.map((f) => <option key={f.id} value={`folder:${f.id}`}>{f.name}</option>)}
                </optgroup>
                {(labels.data?.length ?? 0) > 0 && (
                  <optgroup label="Labels">
                    {labels.data!.map((l) => <option key={l.id} value={`label:${l.id}`}>{l.name}</option>)}
                  </optgroup>
                )}
              </Select>
            )}
          </Field>
          <a
            className={buttonClass('secondary')}
            href={`/api/mailboxes/${mb}/export${exportScope === 'mailbox' ? '' : `?scope=${exportScope.split(':')[0]}&id=${exportScope.split(':')[1]}`}`}
            download
          >
            <Download size={14} /> Download .mbox
          </a>
        </div>
        <p className="mt-2 text-[12px] text-faint">A few exports per hour. Messages without a stored original are rebuilt from their text and attachments.</p>
      </Section>
    </>
  );
}
