#!/usr/bin/env node
/**
 * Auto-sync YouTube → Blog NRamosDev (nramos.dev)
 *
 * Cada vídeo publicado en el canal nramosdev genera su artículo en src/content/posts.
 * Usa el feed RSS público de YouTube (sin API key) + descripción del vídeo.
 *
 * Uso:
 *   node scripts/sync-youtube.mjs            # detecta vídeos nuevos y crea posts
 *   node scripts/sync-youtube.mjs --dry-run  # solo muestra qué crearía
 *   node scripts/sync-youtube.mjs --force    # regenera todos los posts
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'src/content/posts');
const HANDLE = 'nramosdev';
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

// ── 1. Resolver channel_id desde el handle ──
async function resolveChannelId() {
  const res = await fetch(`https://www.youtube.com/@${HANDLE}`, {
    headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'},
  });
  const html = await res.text();
  // patrón real: "browseId":"UCxxxxxxxxxxxxxxxxxxxxxx" del canal
  const m = html.match(/"browseId":"(UC[A-Za-z0-9_-]{22})"/) || html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/);
  if (!m) throw new Error(`No se pudo resolver channel_id de @${HANDLE}`);
  return m[1];
}

// ── 2. Obtener vídeos del RSS del canal ──
async function fetchVideos(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((e) => {
    const g = (tag) => e[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? '';
    const media = (tag) => e[1].match(new RegExp(`media:${tag}[^>]*>([\\s\\S]*?)</media:${tag}>`))?.[1]?.trim() ?? '';
    const mediaAttr = (tag, attr) => e[1].match(new RegExp(`media:${tag}[^>]*${attr}="([^"]*)"`))?.[1] ?? '';
    return {
      id: g('yt:videoId'),
      title: media('title') || g('title'),
      description: media('description') || '',
      published: new Date(g('published')),
      url: g('link') || `https://www.youtube.com/watch?v=${g('yt:videoId')}`,
      views: mediaAttr('statistics', 'views'),
    };
  });
  return entries;
}

// ── 3. Slug desde título ──
function slugify(title) {
  return title
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ── 4. Plantilla de post ES ──
function postTemplate({id, title, description, published, url}) {
  const date = published.toISOString().split('T')[0];
  const excerpt = description.split('\n')[0].slice(0, 160) || title;
  return `---
title: '${title.replace(/'/g, "\\'")}'
description: '${excerpt.replace(/'/g, "\\'")}'
pubDate: ${date}
lang: es
videoId: '${id}'
videoUrl: '${url}'
duration: ''
color: '#ff6a00'
tags: ['youtube', 'nramosdev']
---

## El contexto

Este artículo acompaña al vídeo publicado en el canal [nramosdev](https://www.youtube.com/@${HANDLE}).

${description.slice(0, 800) || ''}

---

*Suscríbete al canal para más análisis de IA en español: https://www.youtube.com/@${HANDLE}*
`;
}

// ── MAIN ──
const channelId = await resolveChannelId();
const videos = await fetchVideos(channelId);
console.log(`Canal @${HANDLE} (${channelId}): ${videos.length} vídeos en RSS`);

fs.mkdirSync(POSTS_DIR, {recursive: true});
let created = 0, skipped = 0;

for (const v of videos) {
  const slug = slugify(v.title);
  const file = path.join(POSTS_DIR, `es-${slug}.mdx`);
  if (fs.existsSync(file) && !force) {
    skipped++;
    continue;
  }
  console.log(`→ ${dryRun ? '[dry] ' : ''}${v.id} | ${v.title} (${v.published.toISOString().split('T')[0]})`);
  if (!dryRun) fs.writeFileSync(file, postTemplate(v));
  created++;
}

console.log(`\nResultado: ${created} creado(s), ${skipped} ya existente(s)${dryRun ? ' [dry-run, nada escrito]' : ''}`);
console.log(`Posts: ${fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.mdx')).length}`);
