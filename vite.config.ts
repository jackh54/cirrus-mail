import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [react(), tailwindcss(), // remoteBindings: false keeps `npm run dev` fully local. The AI binding is remote-only, so with remote bindings on, dev
  // would need a Cloudflare login just to start. Without it AI calls fail in dev and the app falls back to no AI.
  cloudflare({ remoteBindings: false })],
  resolve: {
    alias: { '@shared': '/src/shared' },
  },
});
