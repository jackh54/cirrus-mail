# Cirrus Mail landing page

A static page: `index.html` plus `assets/`. There's no build step, and it makes no external requests: fonts are embedded in `assets/fonts.css` and every icon is inline SVG. You can open `index.html` straight from disk.

## Preview locally

```sh
open site/index.html          # or double-click it
# or serve it:
npx serve site
```

## Deploy to GitHub Pages

GitHub Pages can only publish a branch from the repository root or `/docs`, so publishing `/site` takes a small Actions workflow.

1. Add `.github/workflows/pages.yml`:

   ```yaml
   name: Pages
   on:
     push:
       branches: [main]
       paths: ["site/**"]
     workflow_dispatch:
   permissions:
     contents: read
     pages: write
     id-token: write
   jobs:
     deploy:
       runs-on: ubuntu-latest
       environment:
         name: github-pages
         url: ${{ steps.deployment.outputs.page_url }}
       steps:
         - uses: actions/checkout@v4
         - uses: actions/configure-pages@v5
         - uses: actions/upload-pages-artifact@v3
           with:
             path: site
         - id: deployment
           uses: actions/deploy-pages@v4
   ```

2. In the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push a change under `site/`, or run the workflow by hand. The page is published at `https://<user>.github.io/cirrus-mail/`.

The page uses only relative paths, so it works under a sub-path like that.

## Deploy to Cloudflare Workers (static assets)

`site/wrangler.jsonc` describes an assets-only Worker named `cirrus-mail-site`:

```sh
cd site
npx wrangler deploy --config wrangler.jsonc
```

Pass `--config` explicitly: after you've built the main app, the repository root has a generated `.wrangler/deploy/config.json`, and without the flag Wrangler refuses to pick between the two. Wrangler uploads the folder as static assets and skips the files listed in `.assetsignore`. Add a custom domain under Workers & Pages → `cirrus-mail-site` → Settings → Domains & Routes.

## Editing

- `index.html`: content and the inline icon sprite (`<symbol id="i-…">`)
- `assets/styles.css`: all styles. Dark is the default; the light theme is a `prefers-color-scheme: light` override of the CSS variables at the top.
- `assets/site.js`: the copy button on the CLI snippet
- `assets/fonts.css`: Inter and JetBrains Mono (SIL Open Font License, see `assets/fonts/`), embedded as base64 so the page works over `file://`

The product visual in the hero is plain HTML and CSS (`.app` in the stylesheet), not a screenshot, so it stays sharp and follows the theme.
