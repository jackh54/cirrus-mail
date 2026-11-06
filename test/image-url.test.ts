import { describe, expect, it } from 'vitest';
import { isRemoteImageUrl, remoteImageKey } from '../src/client/lib/image-url';

const PAGE = 'https://mail.example.com/mailboxes/01ABC/threads/01DEF';
const FILE = 'https://mail.example.com/api/files/01JBX4Z9Q8W7E6R5T4Y3U2I1O0?e=1762300000&s=Ab_c-1&inline=1';

describe('#5 client image URL classification', () => {
  it('treats any same-origin URL other than a signed attachment link as remote', () => {
    for (const u of [
      '/api/proxy/image?u=https%3A%2F%2Ftracker.example%2Fp.gif&e=9999999999&s=abc',
      'https://mail.example.com/api/proxy/image?u=x&e=1&s=y',
      '//mail.example.com/api/proxy/image?u=x',
      '../../../api/proxy/image?u=x',
      '\\api\\proxy\\image?u=x',
      'pixel.gif',
      '/api/files/../proxy/image?u=x',
      '/api/files/\\2e\\2e/proxy/image?u=x',          // CSS escapes decode to ../ after this check
      'https://mail.example.com/api/files/01JBX/../../api/proxy/image',
      'https://tracker.example/p.gif',
    ]) {
      expect(isRemoteImageUrl(u, PAGE), u).toBe(true);
    }
  });

  it('keeps signed attachment links, data: images and in-document references local', () => {
    for (const u of [FILE, ' /api/files/01JBX4Z9Q8W7E6R5T4Y3U2I1O0?e=1&s=x ', 'data:image/png;base64,AAAA', '#clip', 'cid:unresolved@x']) {
      expect(isRemoteImageUrl(u, PAGE), u).toBe(false);
    }
  });

  it('signs remote images by their absolute URL', () => {
    expect(remoteImageKey('//cdn.example/a.png', PAGE)).toBe('https://cdn.example/a.png');
    expect(remoteImageKey('https://cdn.example/a b.png', PAGE)).toBe('https://cdn.example/a b.png');
    expect(remoteImageKey('/api/proxy/image?u=x', PAGE)).toBe('https://mail.example.com/api/proxy/image?u=x');
  });
});
