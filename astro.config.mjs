import {defineConfig} from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://nramos.dev',
  integrations: [
    mdx(),
    sitemap({
      changefreq: 'weekly',
      lastmod: new Date(),
      i18n: {
        defaultLocale: 'es',
        locales: {es: 'es', en: 'en'},
      },
    }),
  ],
  vite: {plugins: [tailwindcss()]},
});
