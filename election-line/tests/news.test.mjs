import test from 'node:test';
import assert from 'node:assert/strict';
import {selectNews,clockSpeech,renderNews,speechText,loadNews,readNewsStatus,NEWS_URL} from '../news.js';
import worker from '../worker.js';
import {withFetch,workerRequest,workerEnv,syntheticNews} from './harness.mjs';
const now=Date.parse('2026-10-27T20:30:00Z');
const item=(source='ינון מגל',overrides={})=>({source,date:'2026-10-27T20:00:00Z',title:'עדכון בדיקה על הבחירות',summary:'מידע סינתטי בלבד',...overrides});
const readText=async(r,max)=>{const t=await r.text();if(new TextEncoder().encode(t).length>max)throw new Error('TOO_LARGE');return t;};
test('news: the requested ten in the evening is spoken in Jerusalem time',()=>assert.equal(clockSpeech(Date.parse('2026-10-27T20:00:00Z'),now),'עשר בערב'));
test('news: summer time uses UTC plus three',()=>assert.equal(clockSpeech(Date.parse('2026-07-01T19:00:00Z'),Date.parse('2026-07-01T19:30:00Z')),'עשר בערב'));
for(const [time,expected] of [['20:15','עשר ורבע בערב'],['20:30','עשר וחצי בערב'],['20:05','עשר וחמש דקות בערב']])test('news: clock '+time,()=>assert.equal(clockSpeech(Date.parse('2026-10-27T'+time+':00Z'),Date.parse('2026-10-27T21:00:00Z')),expected));
test('news: previous day is announced',()=>assert.match(clockSpeech(Date.parse('2026-10-26T20:00:00Z'),Date.parse('2026-10-27T01:00:00Z')),/^אתמול/));
for(const source of ['ערוץ 14','עכשיו 14','now14israel','YINONEWS','ינון מגל','עמית סגל','amitsegal'])test('news: requested source '+source,()=>assert.equal(selectNews({items:[item(source)]},now).items.length,1));
test('news: unrelated sources are excluded',()=>assert.equal(selectNews({items:[item('מקור אחר')]},now).items.length,0));
test('news: official Telegram URL can identify the source',()=>assert.equal(selectNews({items:[item('טלגרם',{url:'https://t.me/s/amitsegal/100'})]},now).items[0].source,'amit'));
test('news: conflicting source and Telegram URL are rejected',()=>assert.equal(selectNews({items:[item('ינון מגל',{url:'https://t.me/amitsegal/100'})]},now).items.length,0));
for(const date of ['bad','2026-10-27T20:00:00','2026-10-25T20:00:00Z','2026-10-28T20:00:00Z'])test('news: invalid or stale publication time '+date,()=>assert.equal(selectNews({items:[item('ינון מגל',{date})]},now).items.length,0));
test('news: most recent updates are first and duplicate text is not repeated',()=>{
 const data=selectNews({items:[item('ינון מגל',{date:'2026-10-27T19:00:00Z'}),item('עמית סגל'),item('ערוץ 14',{title:'הודעת בדיקה שונה',date:'2026-10-27T20:20:00Z'})]},now);
 assert.equal(data.items.length,2);assert.equal(data.items[0].source,'now14');assert.equal(data.items[1].source,'amit');
});
test('news: four updates per source preserve all three channels',()=>{
 const rows=['ערוץ 14','ינון מגל','עמית סגל'].flatMap(source=>Array.from({length:8},(_,i)=>item(source,{title:source+' הודעת בדיקה '+i,date:new Date(now-i*60000).toISOString()})));
 const data=selectNews({items:rows},now);assert.equal(data.items.length,12);assert.equal(data.counts.now14,4);assert.equal(data.counts.yinon,4);assert.equal(data.counts.amit,4);
});
test('news: HTML, delimiters and quotes are normalized without protocol injection',()=>{
 const safe=speechText('<script>bad()</script><b>44.9%</b> ש\\"ס&go_to_folder=hangup');assert.match(safe,/44 נקודה 9 אחוזים/);assert.doesNotMatch(safe,/[.\\"'`=&<>-]/);assert.doesNotMatch(safe,/bad\(\)/);
});
test('news: announcement contains source, publication time and root return',()=>{
 const data=selectNews({items:[item()]},now);const output=renderNews(data,'/',now);assert.match(output,/עשר בערב מערוץ ינון מגל/);assert.ok(output.endsWith('&go_to_folder=/'));assert.doesNotMatch(output,/אחוז ההצבעה הארצי/);
});
test('news: no items and authentication failure are different announcements',()=>{
 assert.match(renderNews({items:[]},'/',now),/לא נמצאו/);assert.match(renderNews({state:'authentication_required'},'/',now),/אינם זמינים/);
});
for(const status of [401,403])test('news: source authentication '+status+' is reported without a bypass',async()=>{
 let calls=0;await withFetch(async(url,opts)=>{calls++;assert.equal(url,NEWS_URL);assert.equal(opts.redirect,'manual');return new Response('{"error":"login required"}',{status});},async()=>{
  const result=await loadNews({},{origin:'https://line.example',readText,now});assert.equal(result.state,'authentication_required');assert.equal(result.items,undefined);
 });assert.equal(calls,1);
});
test('news: source URL cannot be changed by the caller or send credentials off-site',async()=>{
 let calls=0;await withFetch(async()=>{calls++;},async()=>assert.equal((await loadNews({NEWS_DATA_URL:'https://evil.example/news'},{origin:'https://line.example',readText,now})).state,'configuration'));assert.equal(calls,0);
});
test('news: valid JSON is limited to the three requested sources',async()=>{
 await withFetch(async()=>new Response(JSON.stringify({items:[item(),item('מקור אחר')]}),{headers:{'Content-Type':'application/json'}}),async()=>assert.equal((await loadNews({},{origin:'https://line.example',readText,now})).items.length,1));
});
for(const body of ['<html>login</html>','{"wrong":[]}','not json'])test('news: malformed source is not spoken '+body,async()=>{
 await withFetch(async()=>new Response(body,{headers:{'Content-Type':'application/json'}}),async()=>assert.equal((await loadNews({},{origin:'https://line.example',readText,now})).items,undefined));
});
for(const path of ['/summary','/news'])test('news: '+path+' reads site news rather than turnout',async()=>{
 const calls=[];await withFetch(async(url)=>{calls.push(url);return new Response(JSON.stringify(syntheticNews()),{headers:{'Content-Type':'application/json'}});},async()=>{
  const r=await worker.fetch(workerRequest(path),{...workerEnv,YEMOT_ROOT:'/'});const text=await r.text();assert.equal(r.headers.get('X-Election-News-State'),'ready');assert.match(text,/מערוץ ינון מגל/);assert.match(text,/מערוץ עמית סגל/);assert.match(text,/מערוץ ארבע עשרה/);assert.doesNotMatch(text,/אחוז ההצבעה/);assert.ok(text.endsWith('&go_to_folder=/'));assert.equal(calls.length,1);assert.equal(calls[0],NEWS_URL);
 });
});
test('news: unauthorized site yields a clear spoken message and a diagnostic state',async()=>{
 await withFetch(async()=>new Response('{"error":"login required"}',{status:401}),async()=>{
  const r=await worker.fetch(workerRequest('/summary'),{...workerEnv,YEMOT_ROOT:'/'});assert.equal(r.status,200);assert.equal(r.headers.get('X-Election-News-State'),'authentication_required');assert.match(await r.text(),/החדשות אינם זמינים/);
 });
});

function memoryCache(){const entries=new Map();return {entries,async match(key){const t=entries.get(key.url);return t===undefined?undefined:new Response(t,{headers:{'Content-Type':'application/json'}});},async put(key,response){entries.set(key.url,await response.text());}};}
test('news: fresh cache avoids source requests and reports selected sources',async()=>{
 const cache=memoryCache();let calls=0;await withFetch(async()=>{calls++;return new Response(JSON.stringify({items:[item()]}),{headers:{'Content-Type':'application/json'}});},async()=>{
  await loadNews({},{origin:'https://line.example',readText,now,cache});const data=await loadNews({},{origin:'https://line.example',readText,now:now+1000,cache});assert.equal(data.items.length,1);assert.equal(calls,1);assert.equal((await readNewsStatus({},'https://line.example',cache)).state,'ready');
 });
});
test('news: refresh failure serves a recent copy with a warning',async()=>{
 const cache=memoryCache();let fail=false;await withFetch(async()=>fail?new Response('down',{status:503}):new Response(JSON.stringify({items:[item()]}),{headers:{'Content-Type':'application/json'}}),async()=>{
  await loadNews({},{origin:'https://line.example',readText,now,cache});fail=true;const data=await loadNews({},{origin:'https://line.example',readText,now:now+31000,cache});assert.equal(data.stale,true);assert.match(renderNews(data,'/',now+31000),/מושמע העותק/);
 });
});
test('news: expired cache is not used after a source failure',async()=>{
 const cache=memoryCache();let fail=false;await withFetch(async()=>fail?new Response('down',{status:503}):new Response(JSON.stringify({items:[item()]}),{headers:{'Content-Type':'application/json'}}),async()=>{
  await loadNews({},{origin:'https://line.example',readText,now,cache});fail=true;assert.equal((await loadNews({},{origin:'https://line.example',readText,now:now+300001,cache})).items,undefined);
 });
});
test('news: login failure has a short backoff and does not create fake news',async()=>{
 const cache=memoryCache();let calls=0;await withFetch(async()=>{calls++;return new Response('login',{status:401});},async()=>{
  await loadNews({},{origin:'https://line.example',readText,now,cache});await loadNews({},{origin:'https://line.example',readText,now:now+1000,cache});assert.equal(calls,1);assert.equal((await readNewsStatus({},'https://line.example',cache)).state,'authentication_required');
 });
});
test('news: authorization is never included in cache keys or spoken content',async()=>{
 const cache=memoryCache();await withFetch(async(_url,opts)=>{assert.equal(opts.headers.Authorization,'Bearer synthetic-test');return new Response(JSON.stringify({items:[item()]}),{headers:{'Content-Type':'application/json'}});},async()=>{
  const data=await loadNews({NEWS_AUTHORIZATION:'Bearer synthetic-test'},{origin:'https://line.example',readText,now,cache});assert.equal(data.items.length,1);assert.ok([...cache.entries.keys()].every(key=>!key.includes('synthetic-test')));assert.doesNotMatch(renderNews(data,'/',now),/synthetic-test/);
 });
});
test('news: oversized individual words are skipped before caching',()=>assert.equal(selectNews({items:[item('ינון מגל',{title:'א'.repeat(201),summary:''})]},now).items.length,0));
test('news: a neighboring future calendar day is not called yesterday',()=>assert.doesNotMatch(clockSpeech(Date.parse('2026-10-27T22:01:00Z'),Date.parse('2026-10-27T21:59:00Z')),/אתמול/));
for(const status of [301,302])test('news: redirect '+status+' is not followed with authorization',async()=>{
 let calls=0;await withFetch(async(_url,opts)=>{calls++;assert.equal(opts.redirect,'manual');return new Response(null,{status,headers:{Location:'https://other.example/login'}});},async()=>{
  const data=await loadNews({NEWS_AUTHORIZATION:'Bearer synthetic-test'},{origin:'https://line.example',readText,now});assert.equal(data.state,'upstream_redirect');assert.equal(calls,1);
 });
});
