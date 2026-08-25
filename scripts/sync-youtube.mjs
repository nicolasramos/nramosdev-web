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

// ── 4. Utilidades de limpieza ──
function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ¿Es una línea de keywords SEO (lista de términos minúsculos separados por comas)?
function isKeywordLine(p) {
  const words = p.split(',').map((w) => w.trim()).filter(Boolean);
  if (words.length < 5) return false;
  // la mayoría de términos debe ir en minúscula (sin mayúsculas internas)
  const lower = words.filter((w) => !/[A-ZÁÉÍÓÚÑ]/.test(w)).length;
  return lower / words.length >= 0.8;
}

// Encabezado de sección suelto de la descripción ("📌 ENLACES:", "📊 DATOS CLAVE")
function sectionHeader(p) {
  const m = p.match(/^(?:📌|📊|🔗|📝|🎯|💡|🏆)\s*([A-Za-zÁÉÍÓÚÑa-z ]{2,40}):?$/);
  if (!m) return null;
  // solo si parece encabezado (mayúscula inicial o todo en mayúsculas)
  const t = m[1].trim();
  return /^[A-ZÁÉÍÓÚÑ]/.test(t) ? t : null;
}

// ── 5. Plantilla de post ES — estilo Medium (artículo largo y detallado) ──
function postTemplate({id, title, description, published, url}) {
  const date = published.toISOString().split('T')[0];
  const desc = decodeEntities(description);
  // Parseo por LÍNEAS: la descripción mezcla párrafos, capítulos, fuentes y keywords SEO
  const kept = [];
  const chapterLines = [];
  const sourceLines = [];
  for (const raw of desc.split('\n')) {
    const line = raw.trim();
    if (!line) { kept.push(''); continue; }
    const src = line.match(/^📄\s*(.+):\s*(https?:\/\/\S+)$/);
    if (src) { sourceLines.push(`${src[1].trim()}: ${src[2].trim()}`); continue; }
    if (line.startsWith('#') || /^(📄|👍|💬|🔔|⏱|🌐|🔗|🐙)/.test(line)) continue;
    if (/^(\d{1,2}:\d{2})\s+\S/.test(line)) { chapterLines.push(line); continue; }
    if (/^CAPÍTULOS/i.test(line.replace(/^⏱️?\s*/, ''))) continue;
    if (isKeywordLine(line)) continue;
    if (/^Canal de nramos\.?dev/i.test(line)) continue;
    // boilerplate de CTA/enlaces fijos — ya está en el footer de la web
    if (/^(Web|LinkedIn|GitHub|Email|Contacto|Sígueme|Blog|nramos\.dev):\s*https?:\/\//i.test(line)) continue;
    if (/^💼\s*linkedin\.com/i.test(line)) continue;
    if (/^(👉\s*)?Suscríbete/i.test(line)) continue;
    if (/^Enlaces:?$/i.test(line)) continue;
    const header = sectionHeader(line);
    if (header) { kept.push(`**${header}**`); continue; }
    kept.push(line);
  }
  const body = kept.join('\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 8);
  const chapters = chapterLines.slice(0, 12).map((l) => {
    const m = l.match(/^(\d{1,2}:\d{2})\s+(.+)$/);
    return `- **${m[1]}** — ${m[2]}`;
  });
  const sources = sourceLines.map((l) => {
    const m = l.match(/^(.+):\s*(https?:\/\/\S+)$/);
    return m ? `- [${m[1].trim()}](${m[2].trim()})` : `- ${l}`;
  });

  const conclusion = body[5] || `Un análisis más en el canal. [Suscríbete](https://www.youtube.com/@${HANDLE}) para no perderte los próximos.`;

  return `---
title: '${title.replace(/'/g, "\\'")}'
description: '${(body[0] || title).slice(0, 160).replace(/'/g, "\\'")}'
pubDate: ${date}
lang: es
videoId: '${id}'
videoUrl: '${url}'
duration: ''
color: '#ff6a00'
tags: ['youtube', 'nramosdev', 'ia', 'análisis']
---

## TL;DR

**${title}**

${body[0] || 'Análisis completo del vídeo publicado en el canal nramosdev.'}

${chapters.length ? `## Capítulos del vídeo

${chapters.join('\n')}
` : ''}
## El contexto

${body[1] || `Este artículo amplía el vídeo publicado en el canal [nramosdev](https://www.youtube.com/@${HANDLE}).`}

## Análisis

${body.slice(2, 5).join('\n\n') || 'El vídeo desgrana el tema con datos verificados, comparativas y conclusiones prácticas. Aquí tienes el contexto por escrito para profundizar.'}

## Puntos clave

- Ver datos y cifras en el vídeo: ${url}
- Investigación previa documentada en el pipeline de vídeo (research.md del proyecto)
- Fuentes primarias listadas a continuación

${sources.length ? `## Fuentes

${sources.join('\n')}
` : ''}
## Conclusión

${conclusion}

---

*Artículo generado automáticamente desde el vídeo publicado en [nramosdev](https://www.youtube.com/@${HANDLE}). Cada número citado proviene de la investigación verificada del pipeline.*
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
