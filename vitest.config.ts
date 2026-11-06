import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));
  return {
    plugins: [
      cloudflareTest({
        main: './src/worker/index.ts',
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // The pool bundles its own workerd, which can trail wrangler's. Pin a date it supports.
          compatibilityDate: '2026-08-22',
          bindings: {
            TEST_MIGRATIONS: migrations,
            SETUP_TOKEN: 'test-setup-token',
            APP_SECRET: 'test-app-secret-0123456789abcdef',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
