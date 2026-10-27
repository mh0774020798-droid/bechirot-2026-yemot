import test from 'node:test';
import assert from 'node:assert/strict';
import {gasHarness, sourceResponse, TOPICS} from './harness.mjs';

test('Google editor self-tests pass', () => assert.equal(gasHarness().context.runSelfTests().ok, true));
test('menu contains all five topics and does not fetch data', () => {
  const h = gasHarness(), out = h.request();
  assert.match(out.text, /^read=t-/);
  assert.match(out.text, /אחוזי הצבעה/);
  assert.match(out.text, /=election_choice,no,1,1,7,No,yes,no,,0123459$/);
  assert.equal(out.mime, 'text/plain'); assert.equal(h.calls.length, 0);
});
for (const choice of ['1', '2', '3', '4', '5']) test(`menu key ${choice} selects physical child`, () => {
  assert.equal(gasHarness().request({topic: 'menu', root: '/8/9', election_choice: choice}).text, 'go_to_folder=/8/9/' + choice);
});
for (const choice of ['0', '9']) test(`menu key ${choice} returns to parent`, () => {
  assert.equal(gasHarness().request({root: '/8/9', election_choice: choice}).text, 'go_to_folder=/8');
  assert.equal(gasHarness().request({election_choice: choice}).text, 'go_to_folder=/');
});
for (const choice of ['6', '8', '1&hangup', '', '11']) test(`invalid choice ${JSON.stringify(choice)} requests input`, () => {
  assert.match(gasHarness().request({election_choice: choice}).text, /^read=t-/);
});
for (const topic of TOPICS) test(`GET and POST fetch only the fixed ${topic} endpoint`, () => {
  for (const method of ['GET', 'POST']) {
    const h = gasHarness();
    assert.match(h.request({topic}, method).text, /^id_list_message=t-/);
    assert.equal(h.calls[0].url, `https://bechirot.onrender.com/api/phone/${topic}.txt`);
    assert.match(h.request({topic}, method).text, /הנתונים באדיבות אתר בחירות 2026/);
    assert.equal(h.calls.length, 1);
  }
});
for (const topic of ['../secret', 'tick', 'testLiveSources', 'constructor', '__proto__']) test(`unknown topic ${topic} cannot trigger network or editor functions`, () => {
  const h = gasHarness(); assert.match(h.request({topic}).text, /הבחירה אינה קיימת/); assert.equal(h.calls.length, 0);
});
for (const root of ['/9&x=1', 'https://attacker.example', '../', '/', '/9\n&hangup', '/a', '/1'.repeat(31)]) test(`invalid root ${JSON.stringify(root)} uses safe fallback`, () => {
  assert.equal(gasHarness().request({root, election_choice: '1'}).text, 'go_to_folder=/9/1');
});
test('sanitizer preserves decimals, turns punctuation into speech, strips protocol delimiters and controls', () => {
  const text = gasHarness().context.electionSafeText_('44.9% שלום. עולם-חדש—בדיקה = &\n\u0000\u202e');
  assert.match(text, /44 נקודה 9 אחוזים/); assert.doesNotMatch(text, /[.\-=&\n\u0000\u202e]/);
});
test('URLs are omitted from narration', () => assert.equal(gasHarness().context.electionSafeText_('ראו https://example.com/a?x=y קישור'), 'ראו קישור'));
test('long speech is split without losing any words', () => {
  const h = gasHarness(), source = Array(800).fill('תוצאות הבחירות').join(' '), chunks = h.context.electionChunks_(source);
  assert.equal(Array.from(chunks).join(' '), source);
  for (const part of chunks) { assert.ok(part.length <= 700); assert.ok(part.split(' ').length <= 85); }
  assert.match(h.context.electionMessage_(source, '/9'), /\.t-/);
});
test('empty speech and unreasonably long tokens are rejected', () => {
  const h = gasHarness(); assert.throws(() => h.context.electionMessage_('', '/9')); assert.throws(() => h.context.electionChunks_('א'.repeat(201)));
});
const badSources = [
  ['HTTP error', sourceResponse('שגיאה', 503)],
  ['login HTML', sourceResponse('<html>כניסה</html>', 200, 'text/html')],
  ['HTML pretending to be text', sourceResponse('<!doctype html><html>כניסה</html>')],
  ['JSON', sourceResponse('{"text":"בחירות"}')],
  ['JSON content-type', sourceResponse('בחירות', 200, 'application/json')],
  ['empty', sourceResponse('')],
  ['whitespace', sourceResponse(' \n ')],
  ['non Hebrew', sourceResponse('Service unavailable')],
  ['too large', sourceResponse('א'.repeat(30001))],
  ['injected protocol', sourceResponse('בחירות&go_to_folder=hangup')],
  ['huge word', sourceResponse('א'.repeat(201))]
];
for (const [name, response] of badSources) test(`invalid upstream: ${name} produces spoken fallback and is not cached`, () => {
  const h = gasHarness({fetch: () => response}), out = h.request({topic: 'results'});
  assert.match(out.text, /^id_list_message=t-לא ניתן/); assert.match(out.text, /&go_to_folder=\/9$/);
  assert.equal(h.cache.get('election:v1:results'), null);
});
test('HTTP header names are case insensitive and a UTF-8 BOM is accepted', () => {
  const h = gasHarness(), r = sourceResponse('\uFEFF עדכון בחירות '); r.getAllHeaders = () => ({'content-type': 'text/plain'});
  assert.equal(h.context.electionSourceText_(r), 'עדכון בחירות');
});
test('fresh cache avoids another upstream fetch; refresh after 30 seconds', () => {
  const h = gasHarness(); h.request({topic: 'turnout'}); h.advance(29999); h.request({topic: 'turnout'});
  assert.equal(h.calls.length, 1); h.advance(2); h.request({topic: 'turnout'}); assert.equal(h.calls.length, 2);
});
test('cache is independent for different topics', () => {
  const h = gasHarness(); for (const topic of TOPICS) h.request({topic}); assert.equal(h.calls.length, 5);
});
test('failed refresh uses recent cache with an explicit age warning', () => {
  const h = gasHarness({fetch: () => { throw new Error('network'); }}); h.seed('results', 'עדכון קודם', 65000);
  const out = h.request({topic: 'results'}).text; assert.match(out, /מושמע עותק/); assert.match(out, /לפני 2 דקות/); assert.match(out, /עדכון קודם/);
});
test('cache older than five minutes is never read as current data', () => {
  const h = gasHarness({fetch: () => { throw new Error('network'); }}); h.seed('results', 'עותק פג תוקף', 300001);
  assert.doesNotMatch(h.request({topic: 'results'}).text, /עותק פג תוקף/);
});
test('cache which expires during a slow failed fetch is rejected', () => {
  const h = gasHarness({fetch: (_url, _opts, api) => { api.advance(20000); throw new Error('timeout'); }}); h.seed('results', 'עותק פג תוקף', 290000);
  assert.doesNotMatch(h.request({topic: 'results'}).text, /עותק פג תוקף/);
});
test('failure backoff avoids repeated upstream calls for ten seconds', () => {
  const h = gasHarness({fetch: () => { throw new Error('network'); }}); h.request({topic: 'results'}); h.request({topic: 'results'});
  assert.equal(h.calls.length, 1); h.advance(10001); h.request({topic: 'results'}); assert.equal(h.calls.length, 2);
});
test('busy per-topic lease returns fallback without launching a second fetch', () => {
  const h = gasHarness(); h.cache.put('election:v1:results:lease', JSON.stringify({id: 'other', until: h.now() + 10000}), 30);
  assert.match(h.request({topic: 'results'}).text, /אינם זמינים/); assert.equal(h.calls.length, 0);
});
test('busy lock uses a stale record with warning', () => {
  const h = gasHarness(); h.seed('results', 'תוצאות קודמות', 31000); h.state.lockBusy = true;
  assert.match(h.request({topic: 'results'}).text, /מושמע עותק/); assert.equal(h.calls.length, 0);
});
test('network is outside global lock and lease is released after success', () => {
  const h = gasHarness(); h.request({topic: 'results'}); assert.equal(h.cache.get('election:v1:results:lease'), null); assert.equal(h.state.locked, false);
});
test('lease is released after upstream error', () => {
  const h = gasHarness({fetch: () => { throw new Error('fail'); }}); h.request({topic: 'results'}); assert.equal(h.cache.get('election:v1:results:lease'), null);
});
test('missing cache service degrades to direct fetch', () => {
  const h = gasHarness(); h.state.cacheDown = true; assert.match(h.request({topic: 'results'}).text, /עדכון בחירות תקין/);
});
test('cache write failure does not discard a valid live response', () => {
  const h = gasHarness(); h.state.cacheWriteDown = true; assert.match(h.request({topic: 'results'}).text, /עדכון בחירות תקין/);
});
test('unavailable lock service does not break live reading', () => {
  const h = gasHarness(); h.state.lockDown = true; assert.match(h.request({topic: 'results'}).text, /עדכון בחירות תקין/);
});
for (const raw of ['not-json', '{"text":"נתונים","fetchedAt":"bad"}', '{"text":"נתונים","fetchedAt":9999999999999}']) test(`corrupt cache ${raw} is ignored`, () => {
  const h = gasHarness(); h.cache.put('election:v1:results', raw, 300); assert.match(h.request({topic: 'results'}).text, /עדכון בחירות תקין/);
});
test('source credit is retained once', () => {
  const credit = 'הנתונים באדיבות אתר בחירות 2026, חדר המצב';
  const h = gasHarness({fetch: () => sourceResponse('עדכון בחירות. ' + credit)});
  assert.equal(h.request({topic: 'summary'}).text.split(credit).length, 2);
});
test('public health reports connectivity and cache ages without fetching sources', () => {
  const h = gasHarness(); h.seed('turnout', 'בחירות', 12000); const result = JSON.parse(h.request({topic: 'health'}).text);
  assert.equal(result.ok, true); assert.equal(result.topics.turnout.ageSeconds, 12); assert.equal(result.topics.results.cached, false); assert.equal(h.calls.length, 0);
});
test('live diagnostic checks all five topics and warms their caches', () => {
  const h = gasHarness(), result = h.context.testLiveSources(); assert.equal(result.ok, true); assert.equal(result.checks.length, 5);
  for (const topic of TOPICS) assert.ok(h.cache.get('election:v1:' + topic));
});
test('live diagnostic reports partial failure without replacing valid cached data', () => {
  const h = gasHarness({fetch: url => sourceResponse('בחירות', url.includes('results') ? 503 : 200)}); h.seed('results', 'עדכון קודם', 40000);
  const result = h.context.testLiveSources(); assert.equal(result.ok, false); assert.equal(result.checks.filter(x => !x.ok).length, 1);
  assert.match(h.cache.get('election:v1:results'), /עדכון קודם/);
});
