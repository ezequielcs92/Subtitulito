// Lógica del addon: subtítulos en inglés (OpenSubtitles) traducidos al español con Gemini.
// Cada usuario carga su propia API key en /configure. Sin dependencias.

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const BATCH = Number(process.env.BATCH_SIZE || 100);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const DEADLINE_MS = Number(process.env.DEADLINE_MS || 280000); // Vercel Hobby corta a los 300 s

const OPENSUBS = 'https://opensubtitles-v3.strem.io';
const KITSU = 'https://anime-kitsu.strem.fun';

// Caché compartida opcional (Upstash Redis, gratis vía Vercel Marketplace)
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const CACHE_TTL = 60 * 60 * 24 * 90; // 90 días

const VARIANTS = {
  latam: 'español latinoamericano neutro',
  rio: 'español rioplatense (Argentina), con voseo',
  es: 'español de España',
};

const baseManifest = {
  id: 'community.subtitulito',
  version: '1.2.0',
  name: 'Subtitulito',
  description: 'Traduce al español los subtítulos en inglés de OpenSubtitles con tu propia API key gratuita de Gemini.',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'kitsu'],
  catalogs: [],
};

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- config del usuario (va codificada en la URL) ---
function decodeCfg(str) {
  try {
    const c = JSON.parse(Buffer.from(str, 'base64url').toString());
    if (typeof c.k !== 'string' || c.k.trim().length < 20) return null;
    return { k: c.k.trim(), v: VARIANTS[c.v] ? c.v : 'latam' };
  } catch {
    return null;
  }
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'subtitulito' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.json();
}

// --- caché ---
async function redis(cmd) {
  if (!REDIS_URL) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    if (!r.ok) return null;
    return (await r.json()).result ?? null;
  } catch {
    return null;
  }
}
const cacheGet = (key) => redis(['GET', `subtitulito:${key}`]);
const cacheSet = (key, val) => redis(['SET', `subtitulito:${key}`, val, 'EX', String(CACHE_TTL)]);

// --- kitsu:ID:EP  ->  ttXXXX:S:E ---
async function resolveId(type, id) {
  if (id.startsWith('tt')) return id;
  if (!id.startsWith('kitsu:')) return null;
  const [, kid] = id.split(':');
  let meta;
  for (const t of [type, 'anime', 'series', 'movie']) {
    try { meta = (await getJson(`${KITSU}/meta/${t}/kitsu:${kid}.json`)).meta; if (meta) break; } catch {}
  }
  if (!meta?.imdb_id) return null;
  if (type === 'movie') return meta.imdb_id;
  const video = (meta.videos || []).find((v) => v.id === id);
  if (!video?.imdbSeason || !video?.imdbEpisode) return null;
  return `${meta.imdb_id}:${video.imdbSeason}:${video.imdbEpisode}`;
}

// --- subtítulo en inglés ---
async function fetchEnglish(type, imdbId) {
  let data = {};
  try { data = await getJson(`${OPENSUBS}/subtitles/${type}/${imdbId}.json`); } catch {}
  const eng = (data.subtitles || []).filter((s) => s.lang === 'eng');
  for (const s of eng.slice(0, 4)) {
    try {
      const r = await fetch(s.url);
      if (!r.ok) continue;
      const cues = parseSrt(await r.text());
      if (cues.length > 5) return cues;
    } catch {}
  }
  throw new Error('No hay subtítulo en inglés en OpenSubtitles para este título.');
}

// --- SRT ---
export function parseSrt(text) {
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const t = lines.findIndex((l) => l.includes('-->'));
    if (t === -1) continue;
    cues.push({ time: lines[t].trim(), text: lines.slice(t + 1).join('\n').trim() });
  }
  return cues;
}

export function buildSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${c.time}\n${c.text}`).join('\n\n') + '\n';
}

const errorSrt = (msg) => buildSrt([{ time: '00:00:00,500 --> 00:00:12,000', text: `[Subtitulito] ${msg}` }]);

// --- Gemini ---
const systemPrompt = (target) => `Sos traductor profesional de subtítulos. Traducí cada elemento del array JSON del inglés al ${target}.
Reglas:
- Devolvé SOLO un array JSON con exactamente la misma cantidad de elementos, en el mismo orden.
- Un elemento traducido por cada elemento original. Nunca unas ni dividas elementos.
- Conservá los saltos de línea (\\n), etiquetas como <i></i> y {\\an8}, y los nombres propios.
- Tono natural y hablado, como un buen fansub. Frases cortas que se lean rápido.`;

async function callGemini(lines, key, target) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(target) }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(lines) }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
    },
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    if (r.status === 429 || r.status >= 500) {
      const wait = 10000 * (attempt + 1);
      log(`Gemini ${r.status}, reintento en ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      const t = await r.text();
      if (/API key|API_KEY|PERMISSION_DENIED|UNAUTHENTICATED/i.test(t)) {
        throw new Error('Tu API key de Gemini no es válida. Revisala en la configuración del addon.');
      }
      throw new Error(`Gemini ${r.status}: ${t.slice(0, 160)}`);
    }
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const data = await r.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return JSON.parse(text);
  }
  throw new Error('Gemini está saturado o se agotó tu cuota gratuita. Probá más tarde.');
}

async function translateBatch(lines, key, target) {
  try {
    const out = await callGemini(lines, key, target);
    if (Array.isArray(out) && out.length === lines.length) return out.map(String);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  if (lines.length === 1) return lines;
  const mid = Math.ceil(lines.length / 2);
  return [
    ...(await translateBatch(lines.slice(0, mid), key, target)),
    ...(await translateBatch(lines.slice(mid), key, target)),
  ];
}

async function translateCues(cues, key, target, label) {
  const batches = [];
  for (let i = 0; i < cues.length; i += BATCH) batches.push(cues.slice(i, i + BATCH));
  const results = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = next++;
      log(`${label}: tanda ${b + 1}/${batches.length}`);
      results[b] = await translateBatch(batches[b].map((c) => c.text), key, target);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return batches.flatMap((batch, bi) => batch.map((c, j) => ({ time: c.time, text: results[bi][j] || c.text })));
}

// --- traducción con deduplicación por instancia ---
const jobs = new Map();
const itemKey = (type, id, v) => Buffer.from(`${type}|${id}|${v}`).toString('base64url');

function getTranslation(type, id, cfg) {
  const key = itemKey(type, id, cfg.v);
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    const cached = await cacheGet(key);
    if (cached) return cached;
    const imdb = await resolveId(type, id);
    if (!imdb) throw new Error('No pude identificar este título en IMDB.');
    log(`Traduciendo ${id} (${imdb}) → ${cfg.v}`);
    const cues = await fetchEnglish(type, imdb);
    const srt = buildSrt(await translateCues(cues, cfg.k, VARIANTS[cfg.v], id));
    await cacheSet(key, srt);
    log(`Listo ${id}: ${cues.length} líneas`);
    return srt;
  })();
  jobs.set(key, job);
  job.then(() => jobs.delete(key), (e) => { log('Error:', e.message); jobs.delete(key); });
  return job;
}

function withDeadline(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('La traducción tardó demasiado. Volvé a elegir la pista en un minuto.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function checkKey(key) {
  if (!key || key.length < 20) return false;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key },
    });
    return r.ok;
  } catch {
    return false;
  }
}

// --- página de configuración ---
function configurePage(base, current) {
  const safeKey = current?.k ? current.k.replace(/[^A-Za-z0-9_\-]/g, '') : '';
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subtitulito</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e8eaf0;--mute:#8b93a7;--acc:#7b6cff;--ok:#3ecf8e;--bad:#ff6b6b}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{color:var(--mute);margin:0 0 20px;font-size:14px}
label{display:block;font-size:13px;color:var(--mute);margin:16px 0 6px}
input,select{width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
input:focus,select:focus{outline:2px solid var(--acc);border-color:transparent}
a{color:var(--acc)}.hint{font-size:12px;margin-top:6px;color:var(--mute)}
.row{display:flex;gap:8px;margin-top:24px}button{flex:1;padding:12px;border:0;border-radius:10px;font:600 15px system-ui,sans-serif;cursor:pointer}
.pri{background:var(--acc);color:#fff}.sec{background:var(--line);color:var(--text)}
#msg{font-size:13px;margin-top:14px;min-height:20px}.ok{color:var(--ok)}.bad{color:var(--bad)}
</style></head><body><div class="card">
<h1>Subtitulito</h1>
<p>Traduce al español los subtítulos en inglés usando tu propia API key gratuita de Gemini.</p>
<label for="k">API key de Gemini</label>
<input id="k" type="password" placeholder="AIza..." autocomplete="off" value="${safeKey}">
<div class="hint">La sacás gratis en <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Queda guardada dentro del link del addon: no compartas ese link.</div>
<label for="v">Variante</label>
<select id="v">
<option value="latam">Latinoamericano neutro</option>
<option value="rio">Rioplatense (con voseo)</option>
<option value="es">España</option>
</select>
<div class="row"><button class="pri" id="install">Instalar en Stremio</button><button class="sec" id="copy">Copiar link</button></div>
<div id="msg"></div>
</div>
<script>
const BASE=${JSON.stringify(base)};
const sel=document.getElementById('v');sel.value=${JSON.stringify(current?.v || 'latam')};
const msg=document.getElementById('msg');
const b64=s=>btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
function say(t,c){msg.textContent=t;msg.className=c||''}
async function build(){
  const k=document.getElementById('k').value.trim();
  if(k.length<20){say('Pegá tu API key primero.','bad');return null}
  say('Verificando la key…');
  try{const r=await fetch(BASE+'/api/check',{headers:{'x-gemini-key':k}});
    const j=await r.json(); if(!j.ok){say('Esa key no funciona. Revisala.','bad');return null}}catch(e){say('No pude verificar la key.','bad');return null}
  return BASE+'/'+b64(JSON.stringify({k,v:sel.value}))+'/manifest.json';
}
document.getElementById('install').onclick=async()=>{const u=await build();if(!u)return;
  say('Key válida. Abriendo Stremio…','ok');location.href=u.replace(/^https?:\\/\\//,'stremio://');};
document.getElementById('copy').onclick=async()=>{const u=await build();if(!u)return;
  try{await navigator.clipboard.writeText(u);say('Link copiado. Pegalo en el buscador de complementos de Stremio.','ok')}
  catch{prompt('Copiá este link:',u);say('')}};
</script></body></html>`;
}

// --- HTTP ---
function send(res, status, body, type = 'application/json; charset=utf-8', cache = 'no-store') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'cache-control': cache,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Vercel reescribe todo a /api/index?__p=<ruta original>
function originalPath(req) {
  const u = new URL(req.url, 'http://x');
  const p = u.searchParams.get('__p');
  if (p !== null) return decodeURIComponent('/' + p.replace(/^\/+/, ''));
  if (u.pathname === '/api/index' || u.pathname === '/api') return '/'; // raíz del sitio
  return decodeURIComponent(u.pathname);
}

const RESERVED = new Set(['', 'manifest.json', 'configure', 'subtitles', 'sub', 'api']);
const SRT_TYPE = 'application/x-subrip; charset=utf-8';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const base = baseUrl(req);
  let p = originalPath(req);

  let cfg = null;
  let cfgStr = '';
  const first = p.split('/')[1] || '';
  if (!RESERVED.has(first)) {
    cfg = decodeCfg(first);
    if (!cfg) return send(res, 400, { error: 'Configuración inválida. Volvé a /configure' });
    cfgStr = first;
    p = p.slice(first.length + 1) || '/';
  }

  if (p === '/' || p === '/configure') return send(res, 200, configurePage(base, cfg), 'text/html; charset=utf-8');

  if (p === '/manifest.json') {
    return send(res, 200, { ...baseManifest, behaviorHints: { configurable: true, configurationRequired: !cfg } });
  }

  if (p === '/api/check') return send(res, 200, { ok: await checkKey(String(req.headers['x-gemini-key'] || '').trim()) });

  const sub = p.match(/^\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]*)?\.json$/);
  if (sub) {
    if (!cfg) return send(res, 200, { subtitles: [] });
    const [, type, id] = sub;
    return send(res, 200, {
      subtitles: [{ id: `subtitulito-${cfg.v}`, url: `${base}/${cfgStr}/sub/${itemKey(type, id, cfg.v)}.srt`, lang: 'spa' }],
    }, 'application/json; charset=utf-8', 'public, max-age=3600');
  }

  const file = p.match(/^\/sub\/([A-Za-z0-9_-]+)\.srt$/);
  if (file && cfg) {
    const [type, id] = Buffer.from(file[1], 'base64url').toString().split('|');
    try {
      const srt = await withDeadline(getTranslation(type, id, cfg), DEADLINE_MS);
      // el CDN de Vercel guarda el resultado: repetir el capítulo no vuelve a llamar a Gemini
      return send(res, 200, srt, SRT_TYPE, 'public, max-age=86400, s-maxage=2592000');
    } catch (e) {
      return send(res, 200, errorSrt(e.message), SRT_TYPE);
    }
  }
  send(res, 404, { error: 'not found' });
}
