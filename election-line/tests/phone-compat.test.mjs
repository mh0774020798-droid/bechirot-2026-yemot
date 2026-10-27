import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../worker.js';
import {gasHarness, sourceResponse, withFetch, workerRequest, workerEnv, googleFromGas} from './harness.mjs';

for (const root of ['/', '/9']) test(`party speech removes quotes and escapes for Yemot at ${root}`, async()=>{
  const h=gasHarness({fetch:()=>sourceResponse('רשימות: ש\\"ס, רע\\"ם, ג\'בארין, רשימה `לדוגמה`')});
  await withFetch(googleFromGas(h),async()=>{
    const text=await(await worker.fetch(workerRequest('/parties'),{...workerEnv,YEMOT_ROOT:root})).text();
    assert.match(text,/רשימות: שס, רעם, גבארין, רשימה לדוגמה/);
    assert.doesNotMatch(text,/[\\"'`]/);assert.ok(text.endsWith('&go_to_folder='+root));
  });
});
test('real party fixture remains complete after phone compatibility normalization',async()=>{
  const source=fs.readFileSync(new URL('./fixtures/parties.txt',import.meta.url),'utf8');
  const h=gasHarness({fetch:()=>sourceResponse(source)});
  await withFetch(googleFromGas(h),async()=>{
    const text=await(await worker.fetch(workerRequest('/parties'),{...workerEnv,YEMOT_ROOT:'/'})).text();
    assert.doesNotMatch(text,/[\\"'`]/);assert.ok(text.includes('.t-'));assert.match(text,/פתק שין סמך/);assert.match(text,/הנתונים באדיבות/);
  });
});
test('normalization never converts a quoted JSON document into IVR commands',async()=>{
  await withFetch(async()=>new Response('"id_list_message=t-שלום&go_to_folder=/9"'),async()=>{
    assert.match(await(await worker.fetch(workerRequest('/parties'),workerEnv)).text(),/לא ניתן לקבל/);
  });
});
test('normalization rejects speech made empty by removing quotes',async()=>{
  await withFetch(async()=>new Response('id_list_message=t-""&go_to_folder=/9'),async()=>{
    assert.match(await(await worker.fetch(workerRequest('/parties'),workerEnv)).text(),/לא ניתן לקבל/);
  });
});
