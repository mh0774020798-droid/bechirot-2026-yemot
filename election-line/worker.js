import {loadNews, renderNews, readNewsStatus} from './news.js';
/** Cloudflare Worker — החליפו את כתובת Google בשורה הבאה. */
const DEFAULT_GOOGLE_SCRIPT_URL = 'PASTE_GOOGLE_APPS_SCRIPT_EXEC_URL_HERE';
const DEFAULT_YEMOT_ROOT = '/'; // תפריט הבחירות בשלוחה הראשית
const TOPICS = ['summary', 'turnout', 'exitpolls', 'results', 'parties'];
const MENU_SUFFIX = '=election_choice,no,1,1,7,No,yes,no,,0123459';
const HEADERS = {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff'};

function rootPath(env) {
  const value = String(env.YEMOT_ROOT || DEFAULT_YEMOT_ROOT);
  if (!(value === '/' || /^\/[0-9]+(?:\/[0-9]+)*$/.test(value)) || value.length > 60) throw new Error('CONFIG_ROOT');
  return value;
}

function googleUrl(env) {
  const value = String(env.GOOGLE_SCRIPT_URL || DEFAULT_GOOGLE_SCRIPT_URL).trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value)) throw new Error('CONFIG_GOOGLE');
  return value;
}

function plain(text, status = 200) { return new Response(text, {status, headers: HEADERS}); }
function unavailable(root) { return plain('id_list_message=t-לא ניתן לקבל כעת את עדכוני הבחירות, אנא נסו שוב בעוד זמן קצר&go_to_folder=' + root); }
function json(data, status = 200) { return new Response(JSON.stringify(data), {status, headers: {...HEADERS, 'Content-Type': 'application/json; charset=utf-8'}}); }

async function parameters(request, url) {
  const p = new URLSearchParams(url.search);
  if (request.method !== 'POST') return p;
  const raw = await limitedText(request, 16384);
  const type = (request.headers.get('Content-Type') || '').toLowerCase().split(';')[0].trim();
  if (type === 'application/json') {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('BODY');
    if (typeof body.election_choice === 'string' || typeof body.election_choice === 'number') p.set('election_choice', String(body.election_choice));
  } else if (!type || type === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(raw);
    if (form.has('election_choice')) p.set('election_choice', form.get('election_choice'));
  } else { throw new Error('BODY_TYPE'); }
  return p;
}

async function limitedText(source, maxBytes) {
  const size = Number(source.headers.get('Content-Length') || 0);
  if (size > maxBytes) throw new Error('TOO_LARGE');
  if (!source.body) return '';
  const reader = source.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error('TOO_LARGE');
      text += decoder.decode(part.value, {stream: true});
    }
    return text + decoder.decode();
  } finally { try { await reader.cancel(); } catch (_) {} reader.releaseLock(); }
}

function validSpeech(value) {
  return value.split('.').every(part => /^t-[^.\-=&<>\u0000-\u001f]+$/.test(part) && part.length <= 702 && part.slice(2).trim().length > 0);
}

function childPath(root, key) { return (root === '/' ? '' : root) + '/' + key; }

function phoneCompatible(text) {
  // מרכאות ASCII ולוכסני escape בתוך טקסט TTS עלולים לשבור את פענוח התשובה בימות.
  // מפעילים רק אחרי אימות הפרוטוקול, ובודקים שוב את התוצאה לפני שליחה.
  return text.replace(/[\\"'`]/g, '');
}

function validIvr(text, topic, root) {
  if (text.length > 120000) return false;
  if (topic === 'menu') {
    const parent = root.slice(0, root.lastIndexOf('/')) || '/';
    if ([parent, ...[1, 2, 3, 4, 5].map(n => childPath(root, n))].some(path => text === 'go_to_folder=' + path)) return true;
    return text.startsWith('read=') && text.endsWith(MENU_SUFFIX) && validSpeech(text.slice(5, -MENU_SUFFIX.length));
  }
  const suffix = '&go_to_folder=' + root;
  return text.startsWith('id_list_message=') && text.endsWith(suffix) && validSpeech(text.slice(16, -suffix.length));
}

function clientIvr(text, topic, sourceRoot, root) {
  if (sourceRoot === root) return text;
  // פריסת Google הקיימת מקבלת נתיב מספרי. מתאימים רק הפניות שכבר אומתו,
  // כדי לתמוך בשלוחה הראשית בלי לדרוש החלפה או פריסה מחדש ב-Google.
  if (topic === 'menu') {
    const prefix = 'go_to_folder=' + sourceRoot + '/';
    if (text.startsWith(prefix)) return 'go_to_folder=' + childPath(root, text.slice(prefix.length));
    return text.replace('לחזרה לתפריט הקודם הקישו אפס', 'להשמעת התפריט מחדש הקישו אפס');
  }
  const suffix = '&go_to_folder=' + sourceRoot;
  return text.slice(0, -suffix.length) + '&go_to_folder=' + root;
}

async function google(env, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Google ContentService מבצע הפניה. נשלחים רק סוג התוכן והבחירה, ללא פרטי המתקשר.
    const response = await fetch(googleUrl(env), {
      method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'},
      body: params.toString(), redirect: 'follow', signal: controller.signal
    });
    if (!response.ok) throw new Error('GOOGLE_HTTP');
    return (await limitedText(response, 120000)).replace(/^\uFEFF/, '').trim();
  } finally { clearTimeout(timer); }
}

function validHealth(data) {
  return data && data.ok === true && data.version === '1.0.0' && typeof data.checkedAt === 'string' &&
    Number.isFinite(Date.parse(data.checkedAt)) && data.topics && TOPICS.every(t => {
      const item = data.topics[t];
      return item && typeof item.cached === 'boolean' && (item.ageSeconds === null || Number.isInteger(item.ageSeconds) && item.ageSeconds >= 0 && item.ageSeconds <= 300);
    });
}

export default {
  async fetch(request, env = {}) {
    if (!['GET', 'POST'].includes(request.method)) return plain('Method not allowed', 405);
    const url = new URL(request.url), path = url.pathname.replace(/\/$/, '') || '/';
    const topic = path === '/' || path === '/menu' ? 'menu' : path === '/news' ? 'summary' : path.slice(1);
    if (![...TOPICS, 'menu', 'health'].includes(topic)) return plain('Not found', 404);
    let root;
    try { root = rootPath(env); }
    catch (_) { return topic === 'health' ? json({ok: false, error: 'configuration'}, 503) : unavailable('/'); }
    try {
      const p = await parameters(request, url);
      if (topic === 'summary') {
        const data=await loadNews(env,{origin:url.origin,readText:limitedText});
        const text=renderNews(data,root);
        if(!validIvr(text,topic,root))throw new Error('PROTOCOL');
        return new Response(text,{headers:{...HEADERS,'X-Election-News-State':data.state}});
      }
      const sourceRoot = root === '/' ? '/9' : root;
      const params = new URLSearchParams({topic, root: sourceRoot});
      // אין העברה של URL, נתיב יעד, טוקן, פעולת ניהול או מספר טלפון מהבקשה.
      if (topic === 'menu' && /^[0-59]$/.test(p.get('election_choice') || '')) params.set('election_choice', p.get('election_choice'));
      const text = await google(env, params);
      if (topic === 'health') {
        const data = JSON.parse(text);
        if (!validHealth(data)) throw new Error('HEALTH');
        const topics = Object.fromEntries(TOPICS.map(t => [t, {cached: data.topics[t].cached, ageSeconds: data.topics[t].ageSeconds}]));
        const news=await readNewsStatus(env,url.origin);
        return json({ok: true, version: data.version, checkedAt: data.checkedAt, topics, news});
      }
      if (!validIvr(text, topic, sourceRoot)) throw new Error('PROTOCOL');
      let reply = phoneCompatible(clientIvr(text, topic, sourceRoot, root));
      if (topic === 'menu' && reply.startsWith('read=')) reply=reply.replace('לתקציר העדכני', 'לעדכוני החדשות');
      if (!validIvr(reply, topic, root)) throw new Error('PROTOCOL');
      return plain(reply);
    } catch (_) {
      return topic === 'health' ? json({ok: false, error: 'google_unavailable'}, 503) : unavailable(root);
    }
  }
};
