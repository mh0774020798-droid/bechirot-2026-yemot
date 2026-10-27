import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {gasHarness, withFetch, workerRequest, workerEnv, goodMessage, googleFromGas, TOPICS, GOOGLE_URL} from './harness.mjs';

test('valid Google response is returned as UTF-8 text without a redirect', async () => {
  await withFetch(async (url, opts) => {
    assert.equal(url, GOOGLE_URL); assert.equal(opts.method, 'POST'); assert.equal(opts.redirect, 'follow');
    assert.equal(new URLSearchParams(opts.body).get('topic'), 'turnout');
    return new Response(goodMessage);
  }, async () => {
    const out = await worker.fetch(workerRequest(), workerEnv);
    assert.equal(out.status, 200); assert.equal(out.headers.get('Location'), null);
    assert.match(out.headers.get('Content-Type'), /text\/plain; charset=utf-8/); assert.match(out.headers.get('Cache-Control'), /no-store/);
    assert.equal(await out.text(), goodMessage);
  });
});
for (const topic of TOPICS.filter(t=>t!=='summary')) test(`route /${topic} fixes the Google topic and return folder`, async () => {
  await withFetch(async (_url, opts) => {
    const p = new URLSearchParams(opts.body); assert.equal(p.get('topic'), topic); assert.equal(p.get('root'), '/9'); return new Response(goodMessage);
  }, async () => assert.equal(await (await worker.fetch(workerRequest('/' + topic + '?topic=health&root=/1&next=hangup'), workerEnv)).text(), goodMessage));
});
for (const path of ['/', '/menu', '/menu/']) test(`menu route ${path} accepts Google read response`, async () => {
  const h = gasHarness(); await withFetch(googleFromGas(h), async () => assert.match(await (await worker.fetch(workerRequest(path), workerEnv)).text(), /^read=t-/));
});
test('multiple spoken chunks, BOM and trailing whitespace are accepted', async () => {
  const expected = 'id_list_message=t-חלק ראשון.t-חלק שני&go_to_folder=/9';
  await withFetch(async () => new Response('\uFEFF' + expected + '\n'), async () => assert.equal(await (await worker.fetch(workerRequest(), workerEnv)).text(), expected));
});
for (const method of ['DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS']) test(`unsupported method ${method} does not call Google`, async () => {
  await withFetch(async () => { throw new Error('unexpected fetch'); }, async () => assert.equal((await worker.fetch(workerRequest('/summary', {method}), workerEnv)).status, 405));
});
for (const path of ['/tick', '/internal/status', '/unknown', '/constructor', '/health/more']) test(`unknown route ${path} is not exposed`, async () => {
  let calls = 0; await withFetch(async () => { calls++; }, async () => assert.equal((await worker.fetch(workerRequest(path), workerEnv)).status, 404)); assert.equal(calls, 0);
});
test('form POST overrides query choice while caller details and admin parameters are dropped', async () => {
  await withFetch(async (_url, opts) => {
    assert.deepEqual(Object.fromEntries(new URLSearchParams(opts.body)), {topic: 'menu', root: '/9', election_choice: '4'});
    return new Response('go_to_folder=/9/4');
  }, async () => {
    const req = workerRequest('/menu?election_choice=1&ApiPhone=0500000000&bridge_key=secret', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'election_choice=4&admin=evil&url=https://evil.example&root=/7&topic=health'});
    assert.equal(await (await worker.fetch(req, workerEnv)).text(), 'go_to_folder=/9/4');
  });
});
test('JSON POST accepts numeric menu choice only', async () => {
  await withFetch(async (_url, opts) => {
    assert.deepEqual(Object.fromEntries(new URLSearchParams(opts.body)), {topic: 'menu', root: '/9', election_choice: '2'});
    return new Response('go_to_folder=/9/2');
  }, async () => assert.equal(await (await worker.fetch(workerRequest('/menu', {method: 'POST', headers: {'Content-Type': 'Application/JSON; charset=UTF-8'}, body: JSON.stringify({election_choice: 2, token: 'secret', ApiPhone: 'private'})}), workerEnv)).text(), 'go_to_folder=/9/2'));
});
for (const body of ['null', '[]', '{bad']) test(`malformed JSON ${body} yields spoken fallback`, async () => {
  let calls = 0; await withFetch(async () => { calls++; }, async () => assert.match(await (await worker.fetch(workerRequest('/menu', {method: 'POST', headers: {'Content-Type': 'application/json'}, body}), workerEnv)).text(), /^id_list_message=t-לא ניתן/)); assert.equal(calls, 0);
});
test('unsupported POST body type is rejected without fetch', async () => {
  let calls = 0; await withFetch(async () => { calls++; }, async () => assert.match(await (await worker.fetch(workerRequest('/menu', {method: 'POST', headers: {'Content-Type': 'multipart/form-data'}, body: 'bad'}), workerEnv)).text(), /לא ניתן/)); assert.equal(calls, 0);
});
test('oversized body is rejected by streamed byte count', async () => {
  let calls = 0; await withFetch(async () => { calls++; }, async () => assert.match(await (await worker.fetch(workerRequest('/summary', {method: 'POST', body: 'א'.repeat(10000)}), workerEnv)).text(), /לא ניתן/)); assert.equal(calls, 0);
});
test('oversized Content-Length is rejected before reading', async () => {
  let calls = 0; await withFetch(async () => { calls++; }, async () => assert.match(await (await worker.fetch(workerRequest('/summary', {method: 'POST', headers: {'Content-Length': '20000'}, body: 'small'}), workerEnv)).text(), /לא ניתן/)); assert.equal(calls, 0);
});
test('invalid menu choice is never forwarded to Google', async () => {
  const h = gasHarness(), calls = []; await withFetch(googleFromGas(h, calls), async () => {
    assert.match(await (await worker.fetch(workerRequest('/menu?election_choice=1%26hangup'), workerEnv)).text(), /^read=/);
    assert.equal(new URLSearchParams(calls[0].init.body).has('election_choice'), false);
  });
});
for (const url of ['https://evil.example/exec', 'https://script.google.com/macros/s/abc/dev', 'https://script.google.com.evil.example/macros/s/a/exec', GOOGLE_URL + '?x=1', '']) test(`bad Google configuration ${JSON.stringify(url)} fails closed`, async () => {
  let calls = 0; await withFetch(async () => { calls++; }, async () => assert.match(await (await worker.fetch(workerRequest(), {...workerEnv, GOOGLE_SCRIPT_URL: url})).text(), /^id_list_message=t-לא ניתן/)); assert.equal(calls, 0);
});
test('invalid configured root returns safely to the system root', async () => {
  const out = await worker.fetch(workerRequest(), {...workerEnv, YEMOT_ROOT: '/9&hangup'}); assert.match(await out.text(), /&go_to_folder=\/$/);
});
const badGoogle = [
  ['HTML login', '<!doctype html><html>login</html>'],
  ['empty text', ''],
  ['plain JSON', '{"ok":true}'],
  ['unexpected redirect', 'go_to_folder=hangup'],
  ['foreign return folder', 'id_list_message=t-שלום&go_to_folder=/1'],
  ['extra command', goodMessage + '&routing_yemot=123'],
  ['injected speech type', 'id_list_message=t-שלום.f-evil&go_to_folder=/9'],
  ['hyphen in spoken content', 'id_list_message=t-שלום-עולם&go_to_folder=/9'],
  ['newline in spoken content', 'id_list_message=t-שלום\nעולם&go_to_folder=/9'],
  ['oversized speech chunk', 'id_list_message=t-' + 'א'.repeat(701) + '&go_to_folder=/9'],
  ['empty speech chunk', 'id_list_message=t-&go_to_folder=/9']
];
for (const [name, text] of badGoogle) test(`invalid Google reply: ${name} yields fallback`, async () => {
  await withFetch(async () => new Response(text), async () => assert.match(await (await worker.fetch(workerRequest(), workerEnv)).text(), /^id_list_message=t-לא ניתן/));
});
test('oversized Google response is rejected while streaming', async () => {
  await withFetch(async () => new Response('א'.repeat(70000)), async () => assert.match(await (await worker.fetch(workerRequest(), workerEnv)).text(), /לא ניתן/));
});
test('HTTP error from Google yields fallback', async () => {
  await withFetch(async () => new Response('error', {status: 500}), async () => assert.match(await (await worker.fetch(workerRequest(), workerEnv)).text(), /לא ניתן/));
});
test('network error from Google yields fallback', async () => {
  await withFetch(async () => { throw new Error('network secret'); }, async () => {
    const out = await (await worker.fetch(workerRequest(), workerEnv)).text(); assert.match(out, /לא ניתן/); assert.doesNotMatch(out, /secret/);
  });
});
test('15 second network deadline aborts fetch and returns a spoken fallback', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  await withFetch(async (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}); started();
  }), async () => {
    const pending = worker.fetch(workerRequest(), workerEnv); await ready; t.mock.timers.tick(15001);
    assert.match(await (await pending).text(), /לא ניתן/);
  });
});
test('health reports Google connectivity and whitelists fields', async () => {
  const h = gasHarness(), out = h.request({topic: 'health'}), data = JSON.parse(out.text); data.secret = 'must not leak'; data.topics.summary.extra = 'secret';
  await withFetch(async () => new Response(JSON.stringify(data)), async () => {
    const r = await worker.fetch(workerRequest('/health'), workerEnv); assert.equal(r.status, 200); const result = await r.json(); assert.equal(result.ok, true); assert.equal(result.secret, undefined); assert.equal(result.topics.summary.extra, undefined);
  });
});
for (const reply of ['<html>login</html>', '{}', '{"ok":false}', '{"ok":true,"version":"wrong"}']) test(`bad health reply ${reply} returns HTTP 503`, async () => {
  await withFetch(async () => new Response(reply), async () => { const out = await worker.fetch(workerRequest('/health'), workerEnv); assert.equal(out.status, 503); assert.equal((await out.json()).ok, false); });
});
