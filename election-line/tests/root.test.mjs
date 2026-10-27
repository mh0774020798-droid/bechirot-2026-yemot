import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import {gasHarness, sourceResponse, TOPICS, withFetch, workerRequest, workerEnv, googleFromGas} from './harness.mjs';

const env = {...workerEnv, YEMOT_ROOT: '/'};
for (const key of ['1','2','3','4','5']) test(`main extension key ${key} selects /${key} using the existing Google deployment`, async () => {
  const h=gasHarness(),calls=[];
  await withFetch(googleFromGas(h,calls),async()=>{
    const text=await(await worker.fetch(workerRequest('/menu?election_choice='+key),env)).text();
    assert.equal(text,'go_to_folder=/'+key);
    assert.equal(new URLSearchParams(calls[0].init.body).get('root'),'/9');
  });
});
for (const topic of TOPICS) test(`main extension ${topic} returns to / after playback`, async () => {
  const h=gasHarness();
  await withFetch(googleFromGas(h),async()=>{
    const text=await(await worker.fetch(workerRequest('/'+topic),env)).text();
    assert.match(text,/^id_list_message=t-/); assert.ok(text.endsWith('&go_to_folder=/'));
    assert.doesNotMatch(text,/\/9|go_to_folder=\/\//); assert.doesNotMatch(text,/לא ניתן לקבל/);
  });
});
for (const key of ['0','9']) test(`main extension key ${key} returns to main menu`, async()=>{
  const h=gasHarness();await withFetch(googleFromGas(h),async()=>assert.equal(await(await worker.fetch(workerRequest('/menu?election_choice='+key),env)).text(),'go_to_folder=/'));
});
test('main extension menu describes repeating the menu at zero',async()=>{
  const h=gasHarness();await withFetch(googleFromGas(h),async()=>{
    const text=await(await worker.fetch(workerRequest('/menu'),env)).text();
    assert.match(text,/^read=t-/);assert.match(text,/להשמעת התפריט מחדש/);assert.doesNotMatch(text,/לתפריט הקודם/);
  });
});
test('default Worker root is the main extension',async()=>{
  const h=gasHarness();await withFetch(googleFromGas(h),async()=>assert.equal(await(await worker.fetch(workerRequest('/menu?election_choice=2'),{GOOGLE_SCRIPT_URL:workerEnv.GOOGLE_SCRIPT_URL})).text(),'go_to_folder=/2'));
});
test('main extension upstream failure returns safely to /',async()=>{
  const h=gasHarness({fetch:()=>sourceResponse('שגיאה',503)});await withFetch(googleFromGas(h),async()=>{
    const text=await(await worker.fetch(workerRequest('/results'),env)).text();
    assert.match(text,/לא ניתן לקבל/);assert.ok(text.endsWith('&go_to_folder=/'));assert.doesNotMatch(text,/\/9/);
  });
});
test('main extension network failure returns safely to /',async()=>{
  await withFetch(async()=>{throw new Error('network');},async()=>assert.ok((await(await worker.fetch(workerRequest('/summary'),env)).text()).endsWith('&go_to_folder=/')));
});
test('main extension rejects unvalidated upstream redirects before mapping',async()=>{
  await withFetch(async()=>new Response('go_to_folder=/9/6'),async()=>assert.match(await(await worker.fetch(workerRequest('/menu?election_choice=1'),env)).text(),/לא ניתן לקבל/));
});
test('main extension retains complete split speech and does not rewrite spoken numbers',async()=>{
  const source=Array(140).fill('רשימה 9 קיבלה 12 מנדטים').join(', '),h=gasHarness({fetch:()=>sourceResponse(source)});
  await withFetch(googleFromGas(h),async()=>{
    const text=await(await worker.fetch(workerRequest('/results'),env)).text();
    assert.ok(text.endsWith('&go_to_folder=/'));assert.ok(text.includes('.t-'));
    assert.equal(text.match(/רשימה 9 קיבלה 12 מנדטים/g).length,140);
  });
});
