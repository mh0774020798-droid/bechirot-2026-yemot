import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../worker.js';
import {gasHarness, sourceResponse, TOPICS, withFetch, workerRequest, workerEnv, googleFromGas} from './harness.mjs';

for (let index = 0; index < TOPICS.length; index++) test(`simulated call: menu → key ${index + 1} → ${TOPICS[index]} → election menu`, async () => {
  const topic = TOPICS[index], text = fs.readFileSync(new URL(`./fixtures/${topic}.txt`, import.meta.url), 'utf8');
  const h = gasHarness({fetch: () => sourceResponse(text)});
  await withFetch(googleFromGas(h), async () => {
    assert.match(await (await worker.fetch(workerRequest('/menu'), workerEnv)).text(), /^read=t-/);
    const choice = await (await worker.fetch(workerRequest('/menu?election_choice=' + (index + 1)), workerEnv)).text();
    assert.equal(choice, 'go_to_folder=/9/' + (index + 1));
    const output = await (await worker.fetch(workerRequest('/' + topic), workerEnv)).text();
    assert.match(output, /^id_list_message=t-/); assert.match(output, /הנתונים באדיבות אתר בחירות 2026/); assert.match(output, /&go_to_folder=\/9$/);
    assert.doesNotMatch(output, /לא ניתן לקבל/);
    const sections = output.slice(16, -'&go_to_folder=/9'.length).split('.');
    assert.ok(sections.every(x => x.startsWith('t-') && x.length <= 702));
    assert.equal(h.calls.length, 1);
    const again = await (await worker.fetch(workerRequest('/' + topic), workerEnv)).text(); assert.equal(again, output); assert.equal(h.calls.length, 1);
  });
});
test('nested election extension uses the configured root throughout the flow', async () => {
  const h = gasHarness(); await withFetch(googleFromGas(h), async () => {
    const env = {...workerEnv, YEMOT_ROOT: '/8/9'};
    assert.equal(await (await worker.fetch(workerRequest('/menu?election_choice=4'), env)).text(), 'go_to_folder=/8/9/4');
    assert.match(await (await worker.fetch(workerRequest('/results'), env)).text(), /&go_to_folder=\/8\/9$/);
    assert.equal(await (await worker.fetch(workerRequest('/menu?election_choice=0'), env)).text(), 'go_to_folder=/8');
  });
});
test('source failure is safely voiced through the entire bridge', async () => {
  const h = gasHarness({fetch: () => sourceResponse('<html>error</html>', 503, 'text/html')});
  await withFetch(googleFromGas(h), async () => {
    const out = await worker.fetch(workerRequest('/results'), workerEnv); assert.equal(out.status, 200); assert.match(await out.text(), /^id_list_message=t-לא ניתן/);
  });
});
test('stale source warning survives the bridge and is never described as current', async () => {
  const h = gasHarness({fetch: () => { throw new Error('network'); }}); h.seed('results', 'תוצאות קודמות', 60000);
  await withFetch(googleFromGas(h), async () => {
    const out = await (await worker.fetch(workerRequest('/results'), workerEnv)).text(); assert.match(out, /מושמע עותק/); assert.match(out, /תוצאות קודמות/);
  });
});
test('normalization of punctuation survives the bridge without swallowing data', async () => {
  const h = gasHarness({fetch: () => sourceResponse('עדכון: 44.9% מהקולות. מפלגה-לדוגמה: 20 מנדטים. & שאר הנתונים=בהמשך')});
  await withFetch(googleFromGas(h), async () => {
    const out = await (await worker.fetch(workerRequest('/results'), workerEnv)).text(); assert.match(out, /44 נקודה 9 אחוזים/); assert.match(out, /20 מנדטים/); assert.doesNotMatch(out, /לא ניתן/);
  });
});
test('a long post-election bulletin is split into supported chunks, without truncation', async () => {
  const body = Array(700).fill('רשימה לדוגמה קיבלה עשרה מנדטים').join(', ');
  const h = gasHarness({fetch: () => sourceResponse(body)});
  await withFetch(googleFromGas(h), async () => {
    const out = await (await worker.fetch(workerRequest('/results'), workerEnv)).text(); assert.doesNotMatch(out, /לא ניתן/);
    const spoken = out.slice(16, -'&go_to_folder=/9'.length).split('.').map(x => x.slice(2)).join(' ');
    assert.ok(spoken.startsWith(h.context.electionSafeText_(body))); assert.equal(spoken.match(/עשרה מנדטים/g).length, 700);
  });
});
test('all six supplied ext.ini files route to the correct Worker handlers', () => {
  const paths = ['menu', ...TOPICS];
  for (let i = 0; i < paths.length; i++) {
    const relative = i ? `9/${i}/ext.ini` : '9/ext.ini';
    const ini = fs.readFileSync(new URL('../yemot/' + relative, import.meta.url), 'utf8');
    assert.match(ini, /^type=api/m); assert.ok(ini.includes('api_link=https://YOUR-WORKER.workers.dev/' + paths[i])); assert.match(ini, /^api_url_post=yes/m); assert.match(ini, /^api_hangup_send=no/m);
  }
});
