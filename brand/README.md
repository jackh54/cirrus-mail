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
| `mark-mono-light.svg` | A single-colour graphite mark (`#15171C`), for **light** backgrounds. |
| `mark-mono-dark.svg` | A single-colour light mark (`#ECEDEF`), for **dark** backgrounds. |
| `wordmark-light.svg` | Mark + "Cirrus Mail" with graphite text, for **light** backgrounds. |
| `wordmark-dark.svg` | Mark + "Cirrus Mail" with light text, for **dark** backgrounds. |
| `icon.svg` | The app tile (gradient rounded square), the source of the PWA icons. |
| `icon-maskable.svg` | The full-bleed cobalt tile with the mark inside the safe zone (Android maskable icon). |
| `icon-apple.svg` | The full-bleed, opaque tile for `apple-touch-icon`. |
| `banner.svg` / `banner.png` | The README header (1280 × 400). |
| `social-card.svg` / `social-card.png` | The GitHub social preview (1280 × 640). |

The `-light` and `-dark` suffixes name the **background** the asset is meant for.

The web app's `public/favicon.svg` and `public/icons/*.png` are built from the same artwork.

## Colours

Cobalt is the one accent. Everything else is hue-neutral graphite. The full token set is in [`docs/design.md`](../docs/design.md) §7.

| Name | Light | Dark | Role |
|---|---|---|---|
| Cobalt | `#2B63E8` | `#4C82FF` | Primary action, selection, focus, unread, links, theme colour |
| Sky | `#5CC8F5` | `#5CC8F5` | The gradient's far end. Brand assets only, never in the UI |
| Background | `#FFFFFF` | `#131417` | Page and pane background |
| Sidebar | `#F7F7F8` | `#0F1013` | Sidebar, and the dark backgrounds of the banner and social card |
| Border | `#E7E8EB` | `#25272D` | Hairlines between panes and rows |
| Foreground | `#15171C` | `#ECEDEF` | Text, and the mono marks |

The signature is the **cobalt → sky gradient**, running from bottom-left to top-right (`#2B63E8` → `#5CC8F5`). It belongs on the mark and the app tile only. Don't use it for backgrounds, buttons or text.

## Type

- **Inter** for the UI, headings and the wordmark. The wordmark sets "Cirrus" in SemiBold (600) and "Mail" in Regular (400), with slightly tightened tracking.
- **JetBrains Mono** for code, addresses and technical labels.

Text in every SVG here is already converted to paths, so the files render the same everywhere without fonts installed. Both typefaces are licensed under the SIL Open Font License.

## Usage rules

- **Do:**
  - Leave clear space around the mark of at least a quarter of its height.
  - Use the gradient mark on white or graphite (`#131417`, `#0F1013`); on anything else, use a mono mark.
  - Keep cobalt small: a glow behind the mark is the most colour a brand image should carry.
  - Use `favicon.svg` or the PWA icons when you need the mark below 24 px. The tile keeps it legible down to 16 px.
- **Don't:**
  - Recolour, stretch, rotate, outline or add effects to the mark.
  - Bring back the retired v0.1 colours (iris `#4F6BFF`, mint `#38D6C4`, navy `#0E1424`), or put navy-tinted greys next to the graphite.
  - Rebuild the wordmark in another font, or change the spacing between the mark and the text.
  - Put the gradient mark on a busy photo or on a mid-tone background.
  - Combine the mark with Cloudflare's logo, or present Cirrus Mail as a Cloudflare product. Refer to Cloudflare by name in text only.

## Rebuilding the PNGs

```sh
npm run brand
```

`scripts/build-brand.mjs` renders `banner.png`, `social-card.png` and `public/icons/*.png` from the SVGs with `@resvg/resvg-js`. Edit the SVGs, then re-run it.
