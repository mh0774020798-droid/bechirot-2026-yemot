import test from 'node:test';
import assert from 'node:assert/strict';
import {buildNewsFiles,syncNewsFiles,readNewsFilesStatus,lastReadyNewsFiles,playerConfig,PLAYER_INTRO} from '../yemot-files.js';
import {withFetch,workerRequest,workerEnv,syntheticTelegram,gasHarness} from './harness.mjs';
import worker from '../worker.js';
const now=Date.parse('2026-10-27T20:30:00Z'),origin='https://line.example',env={YEMOT_API_KEY:'synthetic-api-key-for-tests'};
const readText=async(r,max)=>{const t=await r.text();if(new TextEncoder().encode(t).length>max)throw new Error('TOO_LARGE');return t;};
const options=extra=>({root:'/',origin,readText,now,...extra});
const data=()=>({state:'ready',items:[{source:'yinon',voice:'ערוץ ינון מגל',at:Date.parse('2026-10-27T20:00:00Z'),text:'ידיעת בדיקה אחת'},{source:'amit',voice:'ערוץ עמית סגל',at:Date.parse('2026-10-27T20:15:00Z'),text:'ידיעת בדיקה שנייה'}]});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function memoryCache(){const entries=new Map();return {entries,async match(key){const t=entries.get(key.url);return t===undefined?undefined:json(JSON.parse(t));},async put(key,r){entries.set(key.url,await r.text());}};}
function server(override=()=>null){
 const files=new Map(),folders=new Map(),calls=[];
 return {files,folders,calls,fetch:async(url,init)=>{
  assert.ok(String(url).startsWith('https://www.call2all.co.il/ym/api/'));assert.equal(new URL(url).search,'');assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,env.YEMOT_API_KEY);assert.equal(init.headers['Content-Type'],'application/json');assert.ok(init.signal);
  const action=String(url).split('/').pop(),body=JSON.parse(init.body);assert.equal(body.token,undefined);calls.push({action,body});
  const custom=override(action,body,calls);if(custom)return custom;
  if(action==='GetTextFile')return files.has(body.what)?json({responseStatus:'OK',contents:files.get(body.what)}):json({responseStatus:'ERROR',message:'file does not exist'});
  if(action==='UploadTextFile'){files.set(body.what,body.contents);return json({responseStatus:'OK'});}
  if(action==='UpdateExtension'){folders.set(body.path,{...folders.get(body.path),...body});return json({responseStatus:'OK'});}
  throw new Error('Unexpected action '+action);
 }};
}
test('TTS plan makes one numbered file per update, newest first with original time and source',async()=>{
 const p=await buildNewsFiles(data(),'/',now);assert.equal(p.parent,'/1/1');assert.match(p.folder,/^\/1\/1\/\d{25}$/);assert.equal(p.count,2);
 assert.deepEqual(p.files.map(f=>f.name),['M0000.tts','000.tts','001.tts']);assert.match(p.files[1].contents,/עשר ורבע בערב מערוץ עמית סגל/);assert.match(p.files[2].contents,/עשר בערב מערוץ ינון מגל/);assert.equal(p.config.start,'min');
});
test('TTS file plan is deterministic and changes when news changes',async()=>{
 const first=await buildNewsFiles(data(),'/',now),same=await buildNewsFiles(data(),'/',now+1000),next=data();next.items[0].text='תוכן מעודכן';
 assert.equal(first.fingerprint,same.fingerprint);assert.notEqual(first.folder,(await buildNewsFiles(next,'/',now)).folder);
});
test('native playback controls match the announced next, previous, repeat and main menu keys',()=>{
 const cfg=playerConfig('/');assert.equal(cfg.control_play4,'minus');assert.equal(cfg.control_play6,'next');assert.equal(cfg.control_play5,'restart');assert.equal(cfg.playfile_control_play_0_goto,'/');assert.equal(cfg.playfile_end_goto,'/');assert.equal(cfg.start,'min');assert.match(PLAYER_INTRO,/ארבע.*שש.*חמש.*אפס/);
});
test('nested root changes only the chosen content subtree and return path',async()=>{
 const p=await buildNewsFiles(data(),'/7',now);assert.equal(p.parent,'/7/1/1');assert.ok(p.folder.startsWith('/7/1/1/'));assert.equal(p.config.playfile_end_goto,'/7');
});
for(const root of ['/../1','/1?x=2','https://other.example','/1&go_to_folder=/2'])test('invalid root cannot inject a target '+root,()=>assert.throws(()=>playerConfig(root),/configuration/));
for(const bad of [{}, {items:[]}, {items:Array(13).fill(data().items[0])}, {items:[{...data().items[0],at:now-86400001}]}, {items:[{...data().items[0],voice:'מקור אחר'}]}])test('invalid or unavailable news is not written: '+JSON.stringify(bad).slice(0,70),async()=>assert.rejects(()=>buildNewsFiles(bad,'/',now),/no_news/));
test('partial and cached updates have a warning in their TTS introduction',async()=>{
 const p=await buildNewsFiles({...data(),partial:true,stale:true},'/',now);assert.match(p.files[0].contents,/עותק מהדקות האחרונות/);assert.match(p.files[0].contents,/חלק מערוצי החדשות אינם זמינים/);
});
test('without a management key there are no Yemot API requests',async()=>{
 await withFetch(async()=>{throw new Error('No network expected');},async()=>{assert.equal((await syncNewsFiles(data(),{},options())).state,'not_configured');assert.equal((await readNewsFilesStatus({},origin,'/')).configured,false);});
});
test('invalid secret is rejected locally without exposing it',async()=>{
 await withFetch(async()=>{throw new Error('No network expected');},async()=>assert.equal((await syncNewsFiles(data(),{YEMOT_API_KEY:'key\r\nInjected: bad'},options())).state,'configuration'));
});
test('uploads complete snapshot before publishing the native playback folder',async()=>{
 const s=server();await withFetch(s.fetch,async()=>{
  const r=await syncNewsFiles(data(),env,options());assert.equal(r.state,'ready');assert.equal(r.target,'/1/1');assert.equal(r.count,2);
  const publish=s.calls.findIndex(c=>c.body.folder_to_play),marker=s.calls.findIndex(c=>c.body.what?.endsWith('/news-ready.json')&&c.action==='UploadTextFile');assert.ok(marker>0);assert.ok(publish>marker);
  const source='ivr2:/'+s.calls[publish].body.folder_to_play;assert.equal(s.folders.get('ivr2:/1/1').type,'playfile');assert.ok(s.files.has(source+'/000.tts'));assert.ok(s.files.has(source+'/001.tts'));assert.match(s.files.get('ivr2:/1/1/M0000.tts'),/לעדכון הבא/);
 });
});
test('same content reuses the remote completed snapshot without rewriting its TTS files',async()=>{
 const s=server();await withFetch(s.fetch,async()=>{
  await syncNewsFiles(data(),env,options());const n=s.calls.length;assert.equal((await syncNewsFiles(data(),env,options())).state,'ready');
  const again=s.calls.slice(n);assert.equal(again.filter(c=>c.action==='UploadTextFile'&&!c.body.what.endsWith('/1/1/M0000.tts')).length,0);assert.equal(again[0].action,'GetTextFile');
 });
});
test('fresh cache avoids repeat API reads and writes for thirty seconds',async()=>{
 const s=server(),cache=memoryCache();await withFetch(s.fetch,async()=>{
  await syncNewsFiles(data(),env,options({cache}));const n=s.calls.length;await syncNewsFiles(data(),env,options({cache,now:now+1000}));assert.equal(s.calls.length,n);const state=await readNewsFilesStatus(env,origin,'/',cache);assert.equal(state.configured,true);assert.equal(state.state,'ready');assert.doesNotMatch(JSON.stringify(state),/synthetic-api-key/);assert.ok([...cache.entries.keys()].every(k=>!k.includes(env.YEMOT_API_KEY)));
 });
});
test('new updates do not replace numbered files in a previous playback snapshot',async()=>{
 const s=server();await withFetch(s.fetch,async()=>{
  await syncNewsFiles(data(),env,options());const old=new Map([...s.files].filter(([name])=>/\/\d{25}\//.test(name))),fresh=data();fresh.items[0].text='עדכון שהגיע לאחר מכן';await syncNewsFiles(fresh,env,options());for(const [name,text] of old)assert.equal(s.files.get(name),text);
 });
});
test('completed playback remains available for background refresh for up to five minutes',async()=>{
 const s=server(),cache=memoryCache();await withFetch(s.fetch,async()=>{
  await syncNewsFiles(data(),env,options({cache}));assert.equal((await lastReadyNewsFiles(env,origin,'/',{cache,now:now+290000})).target,'/1/1');assert.equal(await lastReadyNewsFiles(env,origin,'/',{cache,now:now+300001}),null);
 });
});
test('a failed refresh does not erase the last fully uploaded playback set',async()=>{
 const s=server(),cache=memoryCache();await withFetch(s.fetch,async()=>await syncNewsFiles(data(),env,options({cache})));
 await withFetch(async()=>new Response('down',{status:503}),async()=>{await syncNewsFiles(data(),env,options({cache,now:now+31000}));assert.equal((await readNewsFilesStatus(env,origin,'/',cache)).state,'sync_failed');assert.equal((await lastReadyNewsFiles(env,origin,'/',{cache,now:now+31000})).state,'ready');});
});
test('repeat requests during a refresh do not start another upload batch',async()=>{
 const cache=memoryCache();let calls=0;await withFetch(async()=>{calls++;return new Response('down',{status:503});},async()=>{
  assert.equal((await syncNewsFiles(data(),env,options({cache}))).state,'sync_failed');assert.equal((await syncNewsFiles(data(),env,options({cache,now:now+1000}))).state,'refreshing');assert.equal(calls,1);
  await syncNewsFiles(data(),env,options({cache,now:now+26000}));assert.equal(calls,2);
 });
});
test('a warm API entry redirects promptly while waitUntil uploads the next set', {timeout:3000},async()=>{
 const cache=memoryCache(),s=server(),oldCaches=globalThis.caches;globalThis.caches={default:cache};
 let release;const gate=new Promise(resolve=>{release=resolve;});const pending=[];
 try {
  await withFetch(s.fetch,async()=>await syncNewsFiles(data(),env,options({cache,now:Date.now()})));
  await withFetch(async(url,init)=>{if(String(url).startsWith('https://t.me/'))return new Response(syntheticTelegram(new URL(url).pathname.split('/').pop()),{headers:{'Content-Type':'text/html'}});await gate;return s.fetch(url,init);},async()=>{
   const r=await worker.fetch(workerRequest('/summary'),{...workerEnv,YEMOT_ROOT:'/',...env},{waitUntil(p){pending.push(p);}});
   assert.equal(await r.text(),'go_to_folder=/1/1');assert.equal(r.headers.get('X-Election-Playback-Mode'),'files');assert.equal(pending.length,1);release();await Promise.all(pending);
   assert.equal((await lastReadyNewsFiles(env,origin,'/',{cache})).count,3);
  });
 }finally {release();if(oldCaches===undefined)delete globalThis.caches;else globalThis.caches=oldCaches;}
});
test('a failed TTS upload never publishes an incomplete snapshot or deletes existing files',async()=>{
 const s=server((action,body)=>action==='UploadTextFile'&&body.what.endsWith('/001.tts')?json({responseStatus:'ERROR',message:'server secret should not leak'}):null);s.folders.set('ivr2:/1/1',{folder_to_play:'1/1/previous'});
 await withFetch(s.fetch,async()=>{const r=await syncNewsFiles(data(),env,options());assert.equal(r.state,'sync_failed');assert.equal(r.phase,'upload_tts');assert.doesNotMatch(JSON.stringify(r),/server secret|synthetic-api-key/);assert.equal(s.folders.get('ivr2:/1/1').folder_to_play,'1/1/previous');assert.ok(!s.calls.some(c=>c.action==='UploadTextFile'&&c.body.what.endsWith('/news-ready.json')));assert.ok(!s.calls.some(c=>c.action==='FileAction'));});
});
test('foreign or corrupt completion markers are never overwritten',async()=>{
 const p=await buildNewsFiles(data(),'/',now),s=server();s.files.set('ivr2:'+p.folder+'/news-ready.json','{"owner":"another-project"}');await withFetch(s.fetch,async()=>{assert.equal((await syncNewsFiles(data(),env,options())).state,'sync_failed');assert.equal(s.calls.length,1);});
});
for(const status of [302,401,403,500])test('Yemot HTTP '+status+' fails without forwarding the key to another host',async()=>{
 let calls=0;await withFetch(async(url,init)=>{calls++;assert.equal(new URL(url).hostname,'www.call2all.co.il');assert.equal(init.redirect,'manual');return new Response('unavailable',{status,headers:{Location:'https://other.example'}});},async()=>assert.equal((await syncNewsFiles(data(),env,options())).state,'sync_failed'));assert.equal(calls,1);
});
test('oversized Yemot responses and aborted requests return a safe state',async()=>{
 for(const stub of [async()=>new Response('x'.repeat(65537)),async()=>{throw new DOMException('Aborted','AbortError');}])await withFetch(stub,async()=>assert.equal((await syncNewsFiles(data(),env,options())).state,'sync_failed'));
});
test('API entry redirects to the inner native player only after confirmed upload',async()=>{
 const s=server();await withFetch(async(url,init)=>String(url).startsWith('https://t.me/')?new Response(syntheticTelegram(new URL(url).pathname.split('/').pop()),{headers:{'Content-Type':'text/html'}}):s.fetch(url,init),async()=>{
  const r=await worker.fetch(workerRequest('/summary?target=/88&token=caller-injected'),{...workerEnv,YEMOT_ROOT:'/',...env});assert.equal(await r.text(),'go_to_folder=/1/1');assert.equal(r.headers.get('X-Election-Playback-Mode'),'files');assert.equal(r.headers.get('X-Election-Files-State'),'ready');assert.ok(s.calls.every(c=>!JSON.stringify(c.body).includes('/88')));
 });
});
test('when a management request fails the existing news narration stays available',async()=>{
 await withFetch(async url=>String(url).startsWith('https://t.me/')?new Response(syntheticTelegram(new URL(url).pathname.split('/').pop()),{headers:{'Content-Type':'text/html'}}):json({responseStatus:'FORBIDDEN',message:env.YEMOT_API_KEY},403),async()=>{
  const r=await worker.fetch(workerRequest('/summary'),{...workerEnv,YEMOT_ROOT:'/',...env}),text=await r.text();assert.equal(r.headers.get('X-Election-Playback-Mode'),'stream');assert.equal(r.headers.get('X-Election-Files-State'),'sync_failed');assert.match(text,/מערוץ ינון מגל/);assert.doesNotMatch(text,/synthetic-api-key/);
 });
});
test('health clearly distinguishes unconfigured file synchronization from live news',async()=>{
 const h=gasHarness();await withFetch(async()=>json(JSON.parse(h.request({topic:'health'}).text)),async()=>{const r=await worker.fetch(workerRequest('/health'),{...workerEnv,YEMOT_ROOT:'/'}),body=await r.json();assert.equal(body.newsFiles.state,'not_configured');assert.equal(body.newsFiles.player,'/1/1');assert.equal(body.newsFiles.configured,false);});
});
