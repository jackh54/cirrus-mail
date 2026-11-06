import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { ProxySignInput, ProxySignResponse } from '@shared/api';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { api, errorMessage } from '../../lib/api';
import { prepareEmail } from '../../lib/sanitize';

const SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * Renders sanitised email HTML in a script-less, origin-less sandboxed iframe on a white card.
 *
 * Sizing: the visible iframe has no allow-same-origin, so its document cannot be read. We render
 * the identical srcdoc a second time in a hidden, 1 px tall iframe with sandbox="allow-same-origin"
 * and no allow-scripts. Nothing can execute there (sanitised, CSP meta, no script permission), but
 * the parent can read its scrollHeight. We re-measure when its images load and when the container
 * width changes (ResizeObserver on our own container, not on the email document).
 */
export function HtmlBody({ html }: { html: string }) {
  const [signed, setSigned] = useState<Record<string, string> | null>(null);
  const [loadingImages, setLoadingImages] = useState(false);
  const [height, setHeight] = useState(160);
  const prepared = useMemo(() => prepareEmail(html, signed), [html, signed]);
  const container = useRef<HTMLDivElement>(null);
  const measureFrame = useRef<HTMLIFrameElement>(null);
  const { toast } = useToast();

  const measure = useCallback(() => {
    const doc = measureFrame.current?.contentDocument;
    if (!doc?.documentElement) return;
    const root = doc.documentElement;
    // scrollHeight rounds down; a fractional body height would otherwise leave a 1px inner scrollbar.
    const rect = doc.body ? Math.ceil(doc.body.getBoundingClientRect().height) : 0;
    const h = Math.max(root.scrollHeight, doc.body?.scrollHeight ?? 0, rect) + 1;
    const hScroll = root.scrollWidth > root.clientWidth + 1 ? 18 : 0;
    setHeight(Math.max(40, h + hScroll));
  }, []);

  const onMeasureLoad = useCallback(() => {
    measure();
    const doc = measureFrame.current?.contentDocument;
    doc?.querySelectorAll('img').forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', measure, { once: true });
        img.addEventListener('error', measure, { once: true });
      }
    });
    setTimeout(measure, 250);
  }, [measure]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        measure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const loadImages = async () => {
    setLoadingImages(true);
    try {
      const map: Record<string, string> = {};
      for (let i = 0; i < prepared.remoteUrls.length; i += 200) {
        const body: ProxySignInput = { urls: prepared.remoteUrls.slice(i, i + 200) };
        const res = await api.post<ProxySignResponse>('/api/proxy/sign', body);
        Object.assign(map, res.signed);
      }
      setSigned(map);
    } catch (e) {
      toast({ tone: 'error', title: "Couldn't load images", description: errorMessage(e) });
    } finally {
      setLoadingImages(false);
    }
  };

  return (
    <div>
      {prepared.blocked && !signed && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] text-muted">
          <ImageOff size={15} className="shrink-0" />
          <span className="min-w-0 flex-1">Remote images are hidden so the sender can't track when you read this.</span>
          <Button size="sm" variant="secondary" loading={loadingImages} onClick={() => void loadImages()}>
            Load images
          </Button>
        </div>
      )}
      <div ref={container} className="relative overflow-hidden rounded-xl bg-white ring-1 ring-black/5 dark:ring-white/10">
        <iframe
          title="Message content"
          sandbox={SANDBOX}
          srcDoc={prepared.srcdoc}
          referrerPolicy="no-referrer"
          className="block w-full border-0"
          style={{ height }}
        />
        <iframe
          ref={measureFrame}
          title="Message size probe"
          aria-hidden="true"
          tabIndex={-1}
          inert
          sandbox="allow-same-origin"
          srcDoc={prepared.srcdoc}
          onLoad={onMeasureLoad}
          className="pointer-events-none invisible absolute top-0 left-0 w-full border-0"
          style={{ height: 1 }}
        />
      </div>
    </div>
  );
}
