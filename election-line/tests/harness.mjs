import vm from 'node:vm';
import fs from 'node:fs';

const code = fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
export const TOPICS = ['summary', 'turnout', 'exitpolls', 'results', 'parties'];
export const GOOGLE_URL = 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec';

export function sourceResponse(text = 'עדכון בחירות תקין מהמקור', status = 200, type = 'text/plain; charset=utf-8') {
  return {getResponseCode: () => status, getAllHeaders: () => ({'Content-Type': type}), getContentText: () => text};
}

export function gasHarness(options = {}) {
  let now = Date.parse('2026-10-27T13:00:00Z'), sequence = 0;
  const entries = new Map(), calls = [], logs = [], output = [];
  const state = {cacheDown: false, cacheWriteDown: false, lockBusy: false, lockDown: false, locked: false, releases: 0};
  const cache = {
    get(key) {
      if (state.cacheDown) throw new Error('cache unavailable');
      const x = entries.get(key);
      if (!x || x.until <= now) return null;
      return x.value;
    },
    put(key, value, ttl) {
      if (state.cacheDown || state.cacheWriteDown) throw new Error('cache unavailable');
      entries.set(key, {value, until: now + ttl * 1000});
    },
    remove(key) { entries.delete(key); }
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const sandbox = {
    Date: Clock,
    console: {log(value) { logs.push(value); }},
    CacheService: {getScriptCache() { if (state.cacheDown) throw new Error('cache down'); return cache; }},
    LockService: {getScriptLock() {
      if (state.lockDown) throw new Error('lock down');
      return {tryLock() { if (state.lockBusy) return false; state.locked = true; return true; }, releaseLock() { state.locked = false; state.releases++; }};
    }},
    Utilities: {getUuid: () => `uuid-${++sequence}`},
    ContentService: {
      MimeType: {TEXT: 'text/plain', JSON: 'application/json'},
      createTextOutput(text) { const item = {text, mime: null, setMimeType(mime) { this.mime = mime; return this; }}; output.push(item); return item; }
    },
    UrlFetchApp: {
      fetch(url, opts) {
        calls.push({url, opts});
        if (state.locked) throw new Error('network executed under global lock');
        return options.fetch ? options.fetch(url, opts, {advance(ms) { now += ms; }, cache, state}) : sourceResponse();
      },
      fetchAll(requests) { return requests.map(r => sandbox.UrlFetchApp.fetch(r.url, r)); }
    }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context, {filename: 'Code.gs'});
  return {
    context, cache, entries, calls, logs, state, output,
    now: () => now,
    advance(ms) { now += ms; },
    seed(topic, text, ageMs = 0) { cache.put(`election:v1:${topic}`, JSON.stringify({text, fetchedAt: now - ageMs}), 600); },
    request(p = {}, method = 'GET') { return (method === 'GET' ? context.doGet : context.doPost)({parameter: p}); }
  };
}

export async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}

export function workerRequest(path = '/summary', init = {}) { return new Request('https://line.example' + path, init); }
export const workerEnv = {GOOGLE_SCRIPT_URL: GOOGLE_URL, YEMOT_ROOT: '/9'};
export const goodMessage = 'id_list_message=t-עדכון בחירות תקין&go_to_folder=/9';

export function googleFromGas(gas, calls = []) {
  return async (url, init) => {
    calls.push({url, init});
    const p = Object.fromEntries(new URLSearchParams(init.body));
    const out = gas.request(p, 'POST');
    return new Response(out.text, {headers: {'Content-Type': out.mime}});
  };
}
