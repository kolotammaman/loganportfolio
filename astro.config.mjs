// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://loganjmoseley.com',
  integrations: [sitemap()],
  build: {
    // Keep CSS and JS in external files so the page CSP can stay `script-src 'self'; style-src 'self'`.
    inlineStylesheets: 'never',
  },
  vite: {
    build: { assetsInlineLimit: 0 },
  },
});
