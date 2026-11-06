#!/usr/bin/env node
// Renders the PNG brand assets from the SVG sources in brand/.
// Usage: npm run brand
//
// The SVGs have their text already converted to paths, so no fonts are needed here.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [source SVG, output PNG, width in px, opaque background or null] */
const jobs = [
  ['brand/banner.svg', 'brand/banner.png', 1280, null],
  ['brand/social-card.svg', 'brand/social-card.png', 1280, null],
  ['brand/icon.svg', 'public/icons/icon-192.png', 192, null],
  ['brand/icon.svg', 'public/icons/icon-512.png', 512, null],
  ['brand/icon-maskable.svg', 'public/icons/maskable-512.png', 512, '#2B63E8'],
  // Apple touch icons must not be transparent.
  ['brand/icon-apple.svg', 'public/icons/apple-touch-icon.png', 180, '#2B63E8'],
];

let failed = false;
for (const [src, out, width, background] of jobs) {
  try {
    const svg = await readFile(join(root, src));
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: width },
      font: { loadSystemFonts: false },
      shapeRendering: 2,
      ...(background ? { background } : {}),
    });
    const png = resvg.render();
    await mkdir(dirname(join(root, out)), { recursive: true });
    await writeFile(join(root, out), png.asPng());
    console.log(`  ${relative(root, join(root, out))}  ${png.width}x${png.height}`);
  } catch (err) {
    failed = true;
    console.error(`  failed: ${src} -> ${out}: ${err instanceof Error ? err.message : err}`);
  }
}

if (failed) process.exit(1);
console.log('Brand PNGs rendered.');
