import fs from 'node:fs';
import worker from '../worker.js';
import {gasHarness, sourceResponse, TOPICS, withFetch, googleFromGas, workerRequest, workerEnv} from '../tests/harness.mjs';

const sources = await Promise.all(TOPICS.map(async topic => {
  const url = `https://bechirot.onrender.com/api/phone/${topic}.txt`, start = Date.now();
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(30000), headers: {'Accept': 'text/plain', 'Cache-Control': 'no-cache'}});
    const text = await response.text(), type = response.headers.get('Content-Type') || '';
    const h = gasHarness(); h.context.electionSourceText_(sourceResponse(text, response.status, type));
    return {topic, url, ok: true, http: response.status, contentType: type, milliseconds: Date.now() - start, text};
  } catch (error) { return {topic, url, ok: false, milliseconds: Date.now() - start, error: String(error.message)}; }
}));

// תשובות ה-HTTP האמיתיות מוזנות לאותו קוד Google ול-Worker בסימולציה מקומית.
// זהו אימות קוד מול מקור חי, ולא פריסה בחשבונות Google / Cloudflare או שיחת טלפון.
const replay = [];
for (const item of sources.filter(x => x.ok)) {
  const h = gasHarness({fetch: () => sourceResponse(item.text, item.http, item.contentType)});
  await withFetch(googleFromGas(h), async () => {
    const result = await (await worker.fetch(workerRequest('/' + item.topic), workerEnv)).text();
    const ok = result.startsWith('id_list_message=t-') && result.endsWith('&go_to_folder=/9') && !result.includes('לא ניתן לקבל');
    replay.push({topic: item.topic, ok, ivrCharacters: result.length, chunks: result.split('.t-').length});
  });
}
const report = {
  checkedAt: new Date().toISOString(),
  scope: 'Real HTTP source checks plus local replay through Google Apps Script and Worker; no deployed Google/Cloudflare/phone test.',
  ok: sources.length === 5 && sources.every(x => x.ok) && replay.length === 5 && replay.every(x => x.ok),
  sources: sources.map(({text, ...other}) => ({...other, ...(text ? {characters: text.length} : {})})), replay
};
fs.mkdirSync(new URL('../evidence/', import.meta.url), {recursive: true});
fs.writeFileSync(new URL('../evidence/live-check.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
