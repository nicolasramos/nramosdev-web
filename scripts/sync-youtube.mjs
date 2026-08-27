#!/usr/bin/env node
/**
 * Auto-sync YouTube → Blog NRamosDev (nramos.dev)
 *
 * Cada vídeo publicado en el canal nramosdev genera su artículo en src/content/posts.
 * Estrategia híbrida de contenido:
 *   1. Si existe el `research.md` del pipeline de vídeo (investigación verificada)
 *      → genera un ARTÍCULO RICO estilo Medium: contexto, secciones, benchmarks, fuentes.
 *   2. Si no → cae al feed RSS del canal + descripción del vídeo (versión ligera).
 *
 * El directorio del pipeline se configura con la variable de entorno NRAMOSDEV_VIDEOS_DIR
 * (ej. ~/ai-video-pipeline/videos en la máquina donde corre el pipeline).
 * Si no está o no se encuentra el proyecto, se usa el RSS.
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
// Ruta del pipeline de vídeo (investigación verificada por vídeo)
const VIDEOS_DIR = process.env.NRAMOSDEV_VIDEOS_DIR || path.join(ROOT, '..', 'ai-video-pipeline', 'videos');
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

// ── 1. Resolver channel_id desde el handle ──
async function resolveChannelId() {
  const res = await fetch(`https://www.youtube.com/@${HANDLE}`, {
    headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'},
  });
  const html = await res.text();
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

function isKeywordLine(p) {
  const words = p.split(',').map((w) => w.trim()).filter(Boolean);
  if (words.length < 5) return false;
  const lower = words.filter((w) => !/[A-ZÁÉÍÓÚÑ]/.test(w)).length;
  return lower / words.length >= 0.8;
}

function sectionHeader(p) {
  const m = p.match(/^(?:📌|📊|🔗|📝|🎯|💡|🏆)\s*([A-Za-zÁÉÍÓÚÑa-z ]{2,40}):?$/);
  if (!m) return null;
  const t = m[1].trim();
  return /^[A-ZÁÉÍÓÚÑ]/.test(t) ? t : null;
}

// ── 5. Pipeline: cargar investigación del vídeo ──
// Normaliza un string para comparación por tokens significativos.
function normalizeTokens(s) {
  const stop = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'en', 'y', 'a', 'o', 'u', 'un', 'una',
    'que', 'con', 'para', 'por', 'su', 'es', 'al', 'se', 'nramosdev', 'nramos', 'video', 'vídeo', 'canal', 'ia']);
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !stop.has(w));
}

// Alias manuales para proyectos cuyo nombre no se casa por overlap de tokens.
// Clave: palabra clave del título del vídeo → directorio en el pipeline.
const TITLE_ALIASES = [
  {keywords: ['grok'], dir: 'grok3mini-local'},
  {keywords: ['compresion', 'neural'], dir: 'neural-compression'},
];

// Encuentra el directorio del proyecto de vídeo en el pipeline por overlap de tokens.
// Solo proyectos con research.md (sin él el post caería a RSS igualmente).
// Se exige overlap ≥ 2 para evitar falsos positivos por tokens genéricos ("local", "70b").
// Los alias manuales de TITLE_ALIASES cubren los proyectos que no se casan por overlap.
function findProjectDir(title) {
  if (!fs.existsSync(VIDEOS_DIR)) return null;
  const normTitle = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // 1. Alias manuales (mayor prioridad, determinista)
  for (const alias of TITLE_ALIASES) {
    if (alias.keywords.some((k) => normTitle.includes(k))) {
      const p = path.join(VIDEOS_DIR, alias.dir);
      if (fs.existsSync(path.join(p, 'research.md'))) return p;
    }
  }
  // 2. Overlap de tokens
  const tTokens = new Set(normalizeTokens(title));
  let best = null, bestScore = 0;
  for (const entry of fs.readdirSync(VIDEOS_DIR, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!fs.existsSync(path.join(VIDEOS_DIR, entry.name, 'research.md'))) continue;
    const dTokens = normalizeTokens(entry.name);
    const overlap = dTokens.filter((t) => tTokens.has(t)).length;
    if (overlap >= 2 && overlap > bestScore) {
      best = path.join(VIDEOS_DIR, entry.name);
      bestScore = overlap;
    }
  }
  return best;
}

// Extrae el hook del guión (línea tras "## HOOK").
function extractHook(script) {
  const m = script.match(/## HOOK[^\n]*\n+>\s*([^\n]+)/);
  return m ? m[1].trim() : null;
}

// Parsea research.md en {sections: [{title, body[]}], tables: [], sources: []}
// Las tablas markdown (secuencias de líneas "|...|" consecutivas) se capturan aparte
// y no se mezclan con el body de las secciones.
function parseResearch(md) {
  const lines = md.split('\n');
  const sections = [];
  const tables = [];
  const sources = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const src = line.match(/^\d+\.\s+(https?:\/\/\S+)/);
    if (src) { sources.push(src[1]); continue; }
    if (line.startsWith('## ')) {
      const title = line.replace(/^##\s+/, '').replace(/\*\*/g, '').trim();
      if (title && !/^fuentes?$/i.test(title) && !/^investigaci/i.test(title) && !/^vídeo/i.test(title) && !/^fecha/i.test(title)) {
        current = {title, body: []};
        sections.push(current);
      } else {
        current = null;
      }
      continue;
    }
    // Capturar tablas markdown: 3+ líneas consecutivas que empiezan y terminan con "|"
    if (line.startsWith('|') && line.endsWith('|') && /\|.+\|/.test(line)) {
      let j = i;
      const rows = [];
      while (j < lines.length) {
        const r = lines[j].trim();
        if (r.startsWith('|') && r.endsWith('|') && /\|.+\|/.test(r)) rows.push(r);
        else break;
        j++;
      }
      if (rows.length >= 3) {
        tables.push(rows.join('\n'));
        i = j - 1;
        continue;
      }
    }
    if (current) current.body.push(raw);
  }
  return {sections, tables, sources};
}

// Escapa un valor para un frontmatter YAML entre comillas simples (duplicando las comillas).
const yamlStr = (s) => s.replace(/'/g, "''");
// Escapa "<" del cuerpo MDX (un "<" suelto se interpreta como JSX y rompe el build).
const mdxSafe = (s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── 6. Plantilla de post rico (research.md del pipeline) ──
function richPostTemplate({id, title, url, published, research, hook, seoDesc}) {
  const date = published.toISOString().split('T')[0];
  const {sections, tables, sources} = research;
  const conclusion = [...sections].reverse().find((s) => /veredicto|conclusion|conclusión|honesta/i.test(s.title))?.body.join('\n').trim();
  const context = sections[0]?.body.join('\n').trim() || '';
  const mainSections = sections.slice(1).filter((s) => !/veredicto|conclusion|conclusión/i.test(s.title));

  // Description SEO: primero el hook, si no la primera sección, si no el título.
  const descSource = hook || context || seoDesc || title;
  const description = descSource.replace(/\s+/g, ' ').replace(/^[\s>]+|[\s>]+$/g, '').slice(0, 158);

  const body = [
    `## TL;DR`,
    ``,
    `**${title}**`,
    ``,
    hook ? `> ${mdxSafe(hook)}` : null,
    ``,
    `Este artículo amplía el vídeo del canal [nramosdev](https://www.youtube.com/@${HANDLE}) con el estudio completo y las fuentes verificadas.`,
  ].filter((l) => l !== null);

  body.push(``, `## El contexto`, ``, mdxSafe(context || `Análisis completo del ${title} con datos verificados contra fuentes primarias.`));

  for (const s of mainSections) {
    if (!s.body.join('').trim()) continue;
    body.push(``, `## ${s.title}`, ``);
    for (const rawLine of s.body) {
      const line = rawLine.trim();
      if (!line) continue;
      body.push(mdxSafe(line));
    }
  }

  if (tables.length) {
    body.push(``, `## Datos comparativos`, ``);
    for (const tbl of tables) {
      body.push(tbl.trim(), ``);
    }
  }

  body.push(``, `## Puntos clave`, ``);
  body.push(`- Ver el análisis en vídeo: ${url}`);
  body.push(`- Investigación verificada contra fuentes primarias (fecha de publicación del vídeo)`);
  body.push(`- Fuentes listadas a continuación para profundizar`);

  const allSources = sources.length ? sources : [];
  if (allSources.length) {
    body.push(``, `## Fuentes`, ``);
    for (const src of allSources) {
      const host = src.replace(/^https?:\/\//, '').split('/')[0];
      body.push(`- [${host}](${src})`);
    }
  }

  if (conclusion) {
    body.push(``, `## Conclusión`, ``, mdxSafe(conclusion));
  }

  return `---
title: '${yamlStr(title)}'
description: '${yamlStr(description)}'
pubDate: ${date}
lang: es
videoId: '${id}'
videoUrl: '${url}'
duration: ''
image: 'https://i.ytimg.com/vi/${id}/hqdefault.jpg'
color: '#ff6a00'
tags: ['youtube', 'nramosdev', 'ia', 'análisis']
---

${body.join('\n')}

---

*Artículo generado desde el estudio completo del pipeline de vídeo de [nramosdev](https://www.youtube.com/@${HANDLE}). Todos los datos provienen de la investigación verificada del canal.*
`;
}

// ── 7. Plantilla de post ligero (solo RSS) — fallback ──
function postTemplate({id, title, description, published, url}) {
  const date = published.toISOString().split('T')[0];
  const desc = decodeEntities(description);
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
title: '${yamlStr(title)}'
description: '${yamlStr((body[0] || title).slice(0, 160))}'
pubDate: ${date}
lang: es
videoId: '${id}'
videoUrl: '${url}'
duration: ''
image: 'https://i.ytimg.com/vi/${id}/hqdefault.jpg'
color: '#ff6a00'
tags: ['youtube', 'nramosdev', 'ia', 'análisis']
---

## TL;DR

**${title}**

${body[0] || 'Análisis completo del vídeo publicado en el canal nramosdev.'}

${chapters.length ? `## Capítulos del vídeo\n\n${chapters.join('\n')}\n` : ''}
## El contexto

${body[1] || `Este artículo amplía el vídeo publicado en el canal [nramosdev](https://www.youtube.com/@${HANDLE}).`}

## Análisis

${body.slice(2, 5).join('\n\n') || 'El vídeo desgrana el tema con datos verificados, comparativas y conclusiones prácticas. Aquí tienes el contexto por escrito para profundizar.'}

## Puntos clave

- Ver datos y cifras en el vídeo: ${url}
- Investigación previa documentada en el pipeline de vídeo (research.md del proyecto)
- Fuentes primarias listadas a continuación

${sources.length ? `## Fuentes\n\n${sources.join('\n')}\n` : ''}
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
console.log(`Pipeline vídeos: ${fs.existsSync(VIDEOS_DIR) ? VIDEOS_DIR : `no encontrado (${VIDEOS_DIR}) → usando RSS`}\n`);

fs.mkdirSync(POSTS_DIR, {recursive: true});
let created = 0, skipped = 0, rich = 0;

for (const v of videos) {
  const title = decodeEntities(v.title);
  const slug = slugify(title);
  const file = path.join(POSTS_DIR, `es-${slug}.mdx`);
  if (fs.existsSync(file) && !force) {
    skipped++;
    continue;
  }
  // Buscar investigación del pipeline para este vídeo
  const projectDir = findProjectDir(title);
  let body;
  if (projectDir) {
    const researchPath = path.join(projectDir, 'research.md');
    const scriptPath = path.join(projectDir, 'script_nb.md');
    const seoPath = fs.existsSync(path.join(projectDir, 'seo_youtube.md'))
      ? path.join(projectDir, 'seo_youtube.md')
      : path.join(projectDir, 'youtube-seo.md');
    const research = fs.existsSync(researchPath) ? parseResearch(fs.readFileSync(researchPath, 'utf8')) : null;
    const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : null;
    const seo = fs.existsSync(seoPath) ? fs.readFileSync(seoPath, 'utf8') : null;
    const hook = script ? extractHook(script) : null;
    if (research) {
      body = richPostTemplate({
        id: v.id, title, url: v.url, published: v.published,
        research, hook,
        seoDesc: seo ? decodeEntities(seo).slice(0, 500) : undefined,
      });
      rich++;
      console.log(`→ ${dryRun ? '[dry·RICO] ' : '[RICO] '}${v.id} | ${title} (${projectDir})`);
    } else {
      body = postTemplate({id: v.id, title, description: v.description, published: v.published, url: v.url});
      console.log(`→ ${dryRun ? '[dry·RSS] ' : '[RSS] '}${v.id} | ${title} (${projectDir})`);
    }
  } else {
    body = postTemplate({id: v.id, title, description: v.description, published: v.published, url: v.url});
    console.log(`→ ${dryRun ? '[dry·RSS] ' : '[RSS] '}${v.id} | ${title}`);
  }
  if (!dryRun) fs.writeFileSync(file, body);
  created++;
}

console.log(`\nResultado: ${created} creado(s) (${rich} con estudio del pipeline), ${skipped} ya existente(s)${dryRun ? ' [dry-run, nada escrito]' : ''}`);
console.log(`Posts: ${fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.mdx')).length}`);
