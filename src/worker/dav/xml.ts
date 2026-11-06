// A small strict namespace-aware XML parser for DAV request bodies. No DOCTYPE, no entity declarations
// (so no XXE or billion laughs), only the five predefined entities and numeric character references.

export class XmlError extends Error {}

export interface XNode {
  ns: string;
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_ATTRS = 32;
const NAME = /[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/y;

function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);|&/g, (m, e: string | undefined) => {
    if (e === undefined) throw new XmlError('Bad entity');
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isInteger(cp) || (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000)) {
      throw new XmlError('Bad character reference');
    }
    return String.fromCodePoint(cp);
  });
}

export function parseXml(input: string): XNode {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let i = 0;
  let nodes = 0;
  let root: XNode | null = null;
  const stack: { node: XNode; qname: string; scope: Map<string, string> }[] = [];
  const rootScope = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);

  const fail = (m: string): never => { throw new XmlError(m); };
  const skipWs = () => { while (i < src.length && ' \t\r\n'.includes(src[i])) i++; };
  const readName = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(src);
    if (!m) return fail('Bad name');
    i = NAME.lastIndex;
    return m[0];
  };

  while (i < src.length) {
    if (src[i] !== '<') {
      const end = src.indexOf('<', i);
      const raw = src.slice(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
      if (!stack.length) {
        if (raw.trim()) fail('Text outside the root element');
      } else stack[stack.length - 1].node.text += decode(raw);
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end < 0) fail('Unterminated processing instruction');
      i = end + 2;
    } else if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) fail('Unterminated comment');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end < 0 || !stack.length) fail('Bad CDATA');
      stack[stack.length - 1].node.text += src.slice(i + 9, end);
      i = end + 3;
    } else if (src.startsWith('<!', i)) {
      fail('DOCTYPE and entity declarations are not allowed');
    } else if (src.startsWith('</', i)) {
      i += 2;
      const qname = readName();
      skipWs();
      if (src[i] !== '>') fail('Bad closing tag');
      i++;
      const top = stack.pop();
      if (!top || top.qname !== qname) fail('Mismatched closing tag');
    } else {
      i++;
      const qname = readName();
      if (++nodes > MAX_NODES) fail('Document too large');
      const rawAttrs: [string, string][] = [];
      let selfClose = false;
      for (;;) {
        const before = i;
        skipWs();
        if (src[i] === '>') { i++; break; }
        if (src.startsWith('/>', i)) { i += 2; selfClose = true; break; }
        if (i === before) fail('Bad attribute');
        const an = readName();
        skipWs();
        if (src[i] !== '=') fail('Bad attribute');
        i++;
        skipWs();
        const q = src[i];
        if (q !== '"' && q !== "'") fail('Bad attribute');
        const end = src.indexOf(q, i + 1);
        if (end < 0) fail('Bad attribute');
        const val = src.slice(i + 1, end);
        if (val.includes('<')) fail('Bad attribute');
        rawAttrs.push([an, decode(val)]);
        i = end + 1;
        if (rawAttrs.length > MAX_ATTRS) fail('Too many attributes');
      }
      const parentScope = stack.length ? stack[stack.length - 1].scope : rootScope;
      let scope = parentScope;
      for (const [k, v] of rawAttrs) {
        if (k === 'xmlns' || k.startsWith('xmlns:')) {
          if (scope === parentScope) scope = new Map(parentScope);
          scope.set(k === 'xmlns' ? '' : k.slice(6), v);
        }
      }
      const colon = qname.indexOf(':');
      const prefix = colon < 0 ? '' : qname.slice(0, colon);
      const local = colon < 0 ? qname : qname.slice(colon + 1);
      const ns = scope.get(prefix);
      if (ns === undefined && prefix) fail('Unbound namespace prefix');
      const attrs: Record<string, string> = {};
      for (const [k, v] of rawAttrs) {
        if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
        const c = k.indexOf(':');
        attrs[c < 0 ? k : k.slice(c + 1)] = v;
      }
      const node: XNode = { ns: ns ?? '', name: local, attrs, children: [], text: '' };
      if (stack.length) stack[stack.length - 1].node.children.push(node);
      else if (root) fail('More than one root element');
      else root = node;
      if (!selfClose) {
        if (stack.length >= MAX_DEPTH) fail('Document too deep');
        stack.push({ node, qname, scope });
      }
    }
  }
  if (stack.length || !root) fail('Unexpected end of document');
  return root as XNode;
}

export function childOf(n: XNode, ns: string, name: string): XNode | undefined {
  return n.children.find((c) => c.ns === ns && c.name === name);
}

/** Escapes text for element content and attribute values; drops characters XML 1.0 cannot carry. */
export function esc(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
