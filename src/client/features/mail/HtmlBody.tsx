import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { ProxySignInput, ProxySignResponse } from '@shared/api';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { api, errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { emailSrcdoc, prepareEmail, type RenderMode } from '../../lib/sanitize';
import { useDarkTheme } from '../../lib/theme';
import { setDesigned, useRenderPref, wantsDark } from './renderPrefs';

const SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * Renders sanitised email HTML in a script-less, origin-less sandboxed iframe on borderless white paper.
 *
 * Sizing: the visible iframe has no allow-same-origin, so its document cannot be read. We render
 * the identical srcdoc a second time in a hidden, 1 px tall iframe with sandbox="allow-same-origin"
 * and no allow-scripts. Nothing can execute there (sanitised, CSP meta, no script permission), but
 * the parent can read its scrollHeight. We re-measure when its images load and when the container
 * width changes (ResizeObserver on our own container, not on the email document).
 *
 * Dark theme: simple mail renders as native text (mode `dark`), designed mail keeps its light paper
 * (`original`) unless the header toggle forces `invert`. Both iframes get the same document, and every
 * mode keeps the same padding and layout, so toggling never changes the height.
 */
export function HtmlBody({ html, messageId }: { html: string; messageId: string }) {
  const [signed, setSigned] = useState<Record<string, string> | null>(null);
  const [loadingImages, setLoadingImages] = useState(false);
  const [height, setHeight] = useState(160);
  const prepared = useMemo(() => prepareEmail(html, signed), [html, signed]);
  const dark = useDarkTheme();
  const pref = useRenderPref(messageId);
  const mode: RenderMode = !dark || !wantsDark(pref, prepared.designed) ? 'original' : prepared.designed ? 'invert' : 'dark';
  const srcdoc = useMemo(() => emailSrcdoc(prepared, mode), [prepared, mode]);
  // Publish before paint so the header's toggle appears in the same frame as the body.
  useLayoutEffect(() => setDesigned(messageId, prepared.designed), [messageId, prepared.designed]);
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
        <div className="mb-3 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-surface-2 px-3 py-1 text-[12px] text-muted sm:mb-6">
          <ImageOff size={14} strokeWidth={1.75} className="shrink-0" />
          <span className="min-w-0 flex-1">Remote images are hidden so the sender can't track when you read this.</span>
          <Button size="sm" variant="ghost" loading={loadingImages} onClick={() => void loadImages()} className="text-fg">
            Load images
          </Button>
        </div>
      )}
      {/* Same box in every mode (the iframe's 22px padding is pulled into the margin), so nothing shifts. */}
      <div
        ref={container}
        className={cn(
          'relative overflow-hidden rounded-[8px] sm:-mx-[22px] sm:-mt-3',
          mode === 'original' && 'bg-white',
          // Designed mail on dark: a quiet inset edge and slightly lowered brightness so the paper sits in the page.
          mode === 'original' && dark && 'after:pointer-events-none after:absolute after:inset-0 after:rounded-[8px] after:shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08),inset_0_1px_4px_rgb(0_0_0/0.18)] [&>iframe:first-child]:brightness-[0.94]',
        )}
      >
        <iframe
          title="Message content"
          sandbox={SANDBOX}
          srcDoc={srcdoc}
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
          srcDoc={srcdoc}
          onLoad={onMeasureLoad}
          className="pointer-events-none invisible absolute top-0 left-0 w-full border-0"
          style={{ height: 1 }}
        />
      </div>
    </div>
  );
}
