// Reply-template HTML is cleaned before it is stored. The compose editor (TipTap) only keeps the formatting
// it knows, and the Worker does not otherwise rewrite outgoing HTML, so this strips what must never be
// stored: scripts, embeds, forms, event handlers, style rules that load things, and script-capable URLs.

const DROP = 'script,style,iframe,frame,frameset,object,embed,applet,form,input,button,textarea,select,option,base,meta,link,svg,math,template,noscript,portal,title,head';
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'background', 'poster', 'data']);

function dangerousUrl(value: string, attr: string): boolean {
  const s = value.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  if (s.startsWith('javascript:') || s.startsWith('vbscript:')) return true;
  return s.startsWith('data:') && !(attr === 'src' && s.startsWith('data:image/') && !s.startsWith('data:image/svg'));
}

export async function sanitizeTemplateHtml(html: string): Promise<string> {
  const rewriter = new HTMLRewriter()
    .on(DROP, { element(el) { el.remove(); } })
    .on('*', {
      element(el) {
        const attrs = [...el.attributes];
        for (const [name, value] of attrs) {
          const n = name.toLowerCase();
          if (
            n.startsWith('on') || n === 'srcdoc' || n === 'formaction' || n === 'srcset' ||
            (URL_ATTRS.has(n) && dangerousUrl(value, n)) ||
            (n === 'style' && /url\s*\(|expression|javascript:|@import|behavior|-moz-binding/i.test(value))
          ) {
            el.removeAttribute(name);
          }
        }
      },
    });
  return (await rewriter.transform(new Response(html)).text()).trim();
}
