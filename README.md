# nramos.dev — technical blog

Personal tech blog of Nicolás Ramos (NRamosDev). Built with **Astro** (static), Tailwind CSS and MDX. Each YouTube video on the [nramosdev](https://www.youtube.com/@nramosdev) channel gets its own article: context, verified research, benchmarks and sources.

## Tech stack

- **Astro 7** — static site generator
- **Tailwind CSS 4** (via `@tailwindcss/vite`)
- **@astrojs/mdx** — article content
- **@astrojs/sitemap** — sitemap + hreflang alternates

## Project structure

```text
/
├── public/               # static assets (robots.txt, favicons)
├── scripts/
│   └── sync-youtube.mjs  # YouTube → blog sync (generates posts)
└── src/
    ├── content/
    │   ├── config.ts     # content collection schema
    │   └── posts/        # MDX articles (es- and en- prefixed)
    ├── layouts/Base.astro
    └── pages/
        ├── blog/[slug].astro   # ES article (SEO + JSON-LD)
        └── en/blog/[slug].astro # EN article
```

## Commands

| Command                 | Action                                   |
| :---------------------- | :--------------------------------------- |
| `npm install`           | Install dependencies                     |
| `npm run dev`           | Start local dev server at `localhost:4321` |
| `npm run build`         | Build production site to `./dist/`       |
| `npm run preview`       | Preview the build locally                |

## Syncing YouTube → blog

`scripts/sync-youtube.mjs` pulls the channel's RSS feed and generates one MDX post per video. Content strategy is **hybrid**:

1. **Rich article** — if the video's `research.md` from the video pipeline is found, the post is built from the full verified study: context, sections, benchmark tables and sources.
2. **Light article** — otherwise it falls back to the video description (parsed for chapters, sources and key points).

Set the path to the video pipeline (where the per-video `research.md` lives) via the environment variable:

```sh
export NRAMOSDEV_VIDEOS_DIR=/path/to/ai-video-pipeline/videos
node scripts/sync-youtube.mjs            # create posts for new videos
node scripts/sync-youtube.mjs --dry-run  # preview what would be created
node scripts/sync-youtube.mjs --force    # regenerate every post
```

If `NRAMOSDEV_VIDEOS_DIR` is not set, all posts fall back to the RSS-only version.

## SEO

Every article emits:

- **Canonical + hreflang** (es/en/x-default) alternates
- **OpenGraph + Twitter Cards** with the video thumbnail as `og:image`
- **JSON-LD** `Article` + `VideoObject` (rich snippets for Google)
- **Breadcrumbs** and **related posts** (shared tags)
- **Sitemap** (`/sitemap-index.xml`) + **robots.txt**

## License / privacy

Hosted in the EU (GDPR). Contact: [hola@nicolasramos.es](mailto:hola@nicolasramos.es).
