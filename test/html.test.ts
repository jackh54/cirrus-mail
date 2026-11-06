import { describe, expect, it } from 'vitest';
import { HTML_TO_TEXT_MAX, htmlToText } from '../src/worker/lib/html';

describe('htmlToText', () => {
  it('converts basic markup', () => {
    expect(htmlToText('<p>Hello&nbsp;<b>there</b></p><style>p{}</style><ul><li>one</li></ul>')).toBe('Hello there\n\n- one');
    expect(htmlToText('See <a href="https://docs.example/x?a=1&amp;b=2">the docs</a> or <a href="https://y.example">https://y.example</a>.'))
      .toBe('See the docs (https://docs.example/x?a=1&b=2) or https://y.example.');
    expect(htmlToText('a <!-- hidden --> b <script>alert(1)</script>c 1 < 2')).toBe('a b c 1 < 2');
  });

  it('caps its input so hostile HTML cannot take quadratic time', () => {
    const hostile = '<a href="'.repeat(300_000) + '<!--'.repeat(200_000);
    const started = Date.now();
    const out = htmlToText(hostile);
    expect(out.length).toBeLessThanOrEqual(HTML_TO_TEXT_MAX);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(htmlToText('a'.repeat(HTML_TO_TEXT_MAX + 1000)).length).toBe(HTML_TO_TEXT_MAX);
  });
});
