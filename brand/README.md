# Cirrus Mail brand

The mark is an envelope whose flap lifts away as a single soft stroke and curls up like a wisp of cirrus cloud. It is drawn on a 64 × 64 grid with a 4.5-unit round-capped stroke, and it is original artwork for this project.

<p>
  <img src="mark.svg" width="72" alt="Cirrus Mail mark">
  &nbsp;&nbsp;
  <img src="wordmark-light.svg" height="56" alt="Cirrus Mail wordmark">
</p>

## Files

| File | Use it for |
|---|---|
| `mark.svg` | The full-colour gradient mark. Your default choice. |
| `mark-mono-light.svg` | A single-colour ink mark, for **light** backgrounds. |
| `mark-mono-dark.svg` | A single-colour paper mark, for **dark** backgrounds. |
| `wordmark-light.svg` | Mark + "Cirrus Mail" with ink text, for **light** backgrounds. |
| `wordmark-dark.svg` | Mark + "Cirrus Mail" with paper text, for **dark** backgrounds. |
| `icon.svg` | The app tile (gradient rounded square), the source of the PWA icons. |
| `icon-maskable.svg` | The full-bleed iris tile with the mark inside the safe zone (Android maskable icon). |
| `icon-apple.svg` | The full-bleed, opaque tile for `apple-touch-icon`. |
| `banner.svg` / `banner.png` | The README header (1280 × 400). |
| `social-card.svg` / `social-card.png` | The GitHub social preview (1280 × 640). |

The `-light` and `-dark` suffixes name the **background** the asset is meant for.

The web app's `public/favicon.svg` and `public/icons/*.png` are built from the same artwork.

## Colours

| Name | Hex | Role |
|---|---|---|
| Iris | `#4F6BFF` | Primary: buttons, links, focus, theme colour |
| Mint | `#38D6C4` | Accent: highlights, success, the gradient's far end |
| Ink | `#0E1424` | Text on light backgrounds, dark surfaces |
| Paper | `#F7F8FC` | Light surfaces, text on dark backgrounds |

The signature is the **iris → mint gradient**, running from bottom-left to top-right (`#4F6BFF` → `#4A9BEF` at 55% → `#38D6C4`). Use it on the mark and in large accents, not behind body text.

## Type

- **Inter** for the UI, headings and the wordmark. The wordmark sets "Cirrus" in SemiBold (600) and "Mail" in Regular (400), with slightly tightened tracking.
- **JetBrains Mono** for code, addresses and technical labels.

Text in every SVG here is already converted to paths, so the files render the same everywhere without fonts installed. Both typefaces are licensed under the SIL Open Font License.

## Usage rules

- **Do:**
  - Leave clear space around the mark of at least a quarter of its height.
  - Use the gradient mark on ink, paper or white; on anything else, use a mono mark.
  - Use `favicon.svg` or the PWA icons when you need the mark below 24 px. The tile keeps it legible down to 16 px.
- **Don't:**
  - Recolour, stretch, rotate, outline or add effects to the mark.
  - Rebuild the wordmark in another font, or change the spacing between the mark and the text.
  - Put the gradient mark on a busy photo or on a mid-tone background.
  - Combine the mark with Cloudflare's logo, or present Cirrus Mail as a Cloudflare product. Refer to Cloudflare by name in text only.

## Rebuilding the PNGs

```sh
npm run brand
```

`scripts/build-brand.mjs` renders `banner.png`, `social-card.png` and `public/icons/*.png` from the SVGs with `@resvg/resvg-js`. Edit the SVGs, then re-run it.
