/** Editor HTML -> plain text for an encrypted or signed body (paragraphs, lists, quotes and links survive as text). */
export function htmlToPlain(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const render = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    const tag = el.tagName;
    if (tag === 'BR') return '\n';
    if (tag === 'SCRIPT' || tag === 'STYLE') return '';
    const inner = Array.from(el.childNodes, render).join('');
    switch (tag) {
      case 'BLOCKQUOTE':
        return '\n' + inner.trim().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n') + '\n';
      case 'LI':
        return `\n- ${inner.trim()}`;
      case 'A': {
        const href = el.getAttribute('href');
        return href && href !== inner.trim() ? `${inner} (${href})` : inner;
      }
      case 'P': case 'DIV': case 'UL': case 'OL': case 'PRE': case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return `\n${inner}\n`;
      default:
        return inner;
    }
  };
  return render(doc.body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
