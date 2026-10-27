import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTelegram,decodeEntities} from '../telegram.js';
import {loadNews,readNewsStatus,renderNews,selectNews,speechText} from '../news.js';
import worker from '../worker.js';
import {withFetch,workerRequest,workerEnv,syntheticTelegram} from './harness.mjs';
const now=Date.parse('2026-10-27T20:30:00Z');
const origin='https://line.example';
const page=(channel,options={})=>syntheticTelegram(channel,{date:'2026-10-27T20:00:00Z',...options});
const response=(channel,options={})=>new Response(page(channel,options),{headers:{'Content-Type':'text/html; charset=utf-8'}});
const channelOf=url=>new URL(url).pathname.split('/').pop();
const readText=async(r,max)=>{const t=await r.text();if(new TextEncoder().encode(t).length>max)throw new Error('TOO_LARGE');return t;};
const options=extra=>({origin,readText,now,...extra});
function memoryCache(){const entries=new Map();return {entries,async match(key){const t=entries.get(key.url);return t===undefined?undefined:new Response(t,{headers:{'Content-Type':'application/json'}});},async put(key,r){entries.set(key.url,await r.text());}};}

test('Telegram parser keeps nested quotes in the message and excludes the footer',()=>{
 const parsed=parseTelegram(page('yinonews',{text:'ראשית <b>בדיקה</b><div class="quote">ציטוט <i>פנימי</i></div><br>סוף &amp; &#x5D0; &#1489;'}),'yinonews');
 assert.equal(parsed.posts,1);assert.equal(parsed.items[0].date,'2026-10-27T20:00:00Z');
 assert.equal(parsed.items[0].url,'https://t.me/yinonews/100');
 const text=selectNews(parsed,now).items[0].text;assert.match(text,/ציטוט פנימי/);assert.match(text,/סוף/);assert.doesNotMatch(text,/123|22:00|views|footer/);
});
test('Telegram parser ignores other channels and script-created fake posts',()=>{
 const html='<script>'+page('yinonews',{text:'הודעה שאינה אמיתית'})+'</script>'+page('other',{text:'מקור אחר'})+page('yinonews',{text:'ההודעה הנכונה'});
 const parsed=parseTelegram(html,'yinonews');assert.equal(parsed.posts,1);assert.equal(parsed.items[0].summary,'ההודעה הנכונה');
});
test('Telegram parser handles single-quoted attributes and channel case',()=>{
 const html=page('YINONEWS').replaceAll('"',"'");assert.equal(parseTelegram(html,'yinonews').items.length,1);
});
test('Telegram parser keeps each publication time with its own message',()=>{
 const data=parseTelegram(page('amitsegal',{text:'ידיעה ראשונה',post:100,date:'2026-10-27T19:00:00Z'})+page('amitsegal',{text:'ידיעה שנייה',post:101,date:'2026-10-27T20:15:00Z'}),'amitsegal');
 const selected=selectNews(data,now);assert.equal(selected.items[0].at,Date.parse('2026-10-27T20:15:00Z'));assert.match(selected.items[0].text,/שנייה/);
});
test('Telegram media without a caption is not invented or transcribed',()=>{
 const data=parseTelegram(page('yinonews').replace(/<div class="tgme_widget_message_text[^]*?<\/div>/,''),'yinonews');assert.equal(data.posts,1);assert.deepEqual(data.items,[]);
});
for(const html of ['<html>login required</html>','<html>Site Unavailable</html>','<div class="tgme_widget_message_wrap"></div>'])test('Telegram non-feed response is rejected: '+html,()=>assert.throws(()=>parseTelegram(html,'yinonews'),/upstream_shape/));
test('Telegram invalid channel and oversized feed are rejected',()=>{
 assert.throws(()=>parseTelegram(page('yinonews'),'../private'),/upstream_shape/);assert.throws(()=>parseTelegram('a'.repeat(1500001),'yinonews'),/upstream_shape/);
});
test('Telegram entity decoding cannot inject IVR parameters or controls',()=>{
 assert.equal(decodeEntities('&#x5d0;&#1489;'),'אב');
 const text=speechText('חדשות &#38;go_to_folder&#61;hangup &#34; &#39; &#92; &#0; &#x110000;');assert.doesNotMatch(text,/[=&\\"'\u0000]/);
});
test('Telegram long excerpts announce that the original message continues',()=>{
 const data=selectNews(parseTelegram(page('yinonews',{text:Array(90).fill('בדיקה').join(' ')}),'yinonews'),now);assert.match(data.items[0].text,/המשך ההודעה בערוץ$/);
});

test('public Telegram feeds provide all three sources with no site credentials',async()=>{
 const calls=[];await withFetch(async(url,init)=>{calls.push(url);assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers.Cookie,undefined);return response(channelOf(url));},async()=>{
  const result=await loadNews({NEWS_DATA_URL:'https://unrelated.example',NEWS_AUTHORIZATION:'do-not-send' },options());assert.equal(result.state,'ready');assert.equal(result.items.length,3);assert.equal(result.channels.now14.channel,'c14news');assert.equal(result.channels.now14.fallback,false);
  const text=renderNews(result,'/',now);for(const source of ['מערוץ ינון מגל','מערוץ עמית סגל','מערוץ ארבע עשרה'])assert.ok(text.includes(source));assert.match(text,/עשר בערב/);assert.ok(text.endsWith('&go_to_folder=/'));assert.doesNotMatch(text,/אתר בחירות|do-not-send/);
 });assert.deepEqual(calls.sort(),['https://t.me/s/amitsegal','https://t.me/s/c14news','https://t.me/s/yinonews']);
});
for(const status of [401,403,404,429,503])test('c14news failure '+status+' uses only the user-selected public fallback',async()=>{
 const calls=[];await withFetch(async url=>{calls.push(url);return channelOf(url)==='c14news'?new Response('unavailable',{status}):response(channelOf(url));},async()=>{
  const result=await loadNews({},options());assert.equal(result.state,'ready');assert.equal(result.channels.now14.channel,'now14israel');assert.equal(result.channels.now14.fallback,true);assert.equal(result.channels.now14.items,1);
 });assert.equal(calls.length,4);assert.ok(calls.includes('https://t.me/s/now14israel'));
});
test('an inactive primary channel switches to a recent fallback',async()=>{
 await withFetch(async url=>response(channelOf(url),channelOf(url)==='c14news'?{date:'2026-10-25T20:00:00Z'}:{}),async()=>{
  const result=await loadNews({},options());assert.equal(result.channels.now14.channel,'now14israel');assert.equal(result.items.length,3);
 });
});
test('one unavailable channel does not prevent other channels from being heard',async()=>{
 await withFetch(async url=>channelOf(url)==='amitsegal'?new Response('down',{status:503}):response(channelOf(url)),async()=>{
  const result=await loadNews({},options());assert.equal(result.state,'partial');assert.equal(result.items.length,2);assert.match(renderNews(result,'/',now),/חלק מערוצי החדשות אינם זמינים/);assert.equal(result.channels.amit.items,0);
 });
});
test('total feed failure is explicit and creates no invented news',async()=>{
 await withFetch(async()=>new Response('down',{status:503}),async()=>{const result=await loadNews({},options());assert.equal(result.state,'unavailable');assert.equal(result.items,undefined);assert.match(renderNews(result,'/',now),/אינם זמינים/);});
});
test('fresh per-channel cache avoids all source requests',async()=>{
 const cache=memoryCache();let calls=0;await withFetch(async url=>{calls++;return response(channelOf(url));},async()=>{
  await loadNews({},options({cache}));const result=await loadNews({},options({cache,now:now+1000}));assert.equal(result.items.length,3);assert.equal(calls,3);
  const status=await readNewsStatus({},origin,cache);assert.equal(status.provider,'telegram_public');assert.equal(status.channels.now14.channel,'c14news');
 });
});
test('a recent cached channel is announced when its refresh fails',async()=>{
 const cache=memoryCache();let fail=false;await withFetch(async url=>fail&&channelOf(url)==='amitsegal'?new Response('down',{status:503}):response(channelOf(url)),async()=>{
  await loadNews({},options({cache}));fail=true;const result=await loadNews({},options({cache,now:now+31000}));assert.equal(result.state,'cached');assert.equal(result.items.length,3);assert.equal(result.channels.amit.state,'cached');assert.match(renderNews(result,'/',now),/עותק קודם/);
 });
});
test('a live fallback is preferred over an unavailable primary with a cached copy',async()=>{
 const cache=memoryCache();let fail=false;await withFetch(async url=>fail&&channelOf(url)==='c14news'?new Response('down',{status:503}):response(channelOf(url)),async()=>{
  await loadNews({},options({cache}));fail=true;const result=await loadNews({},options({cache,now:now+31000}));assert.equal(result.channels.now14.channel,'now14israel');assert.equal(result.state,'ready');assert.equal(result.stale,false);
 });
});
test('expired copies older than five minutes are not voiced after a failure',async()=>{
 const cache=memoryCache();let fail=false;await withFetch(async url=>fail?new Response('down',{status:503}):response(channelOf(url)),async()=>{
  await loadNews({},options({cache}));fail=true;const result=await loadNews({},options({cache,now:now+300001}));assert.equal(result.items,undefined);
 });
});
test('temporary feed failures have a bounded retry backoff',async()=>{
 const cache=memoryCache();let calls=0;await withFetch(async()=>{calls++;return new Response('down',{status:503});},async()=>{
  await loadNews({},options({cache}));await loadNews({},options({cache,now:now+1000}));assert.equal(calls,4);
 });
});
for(const [status,type,body] of [[302,'text/html','redirect'],[200,'application/json','{}'],[200,'text/html','not a feed']])test('unexpected upstream '+status+' '+type+' is not read as news',async()=>{
 await withFetch(async()=>new Response(body,{status,headers:{'Content-Type':type,Location:'https://unrelated.example'}}),async()=>assert.equal((await loadNews({},options())).items,undefined));
});
test('overlarge responses and aborts are handled without news or leaked timers',async()=>{
 for(const stub of [async()=>new Response('x'.repeat(1500001),{headers:{'Content-Type':'text/html'}}),async()=>{throw new DOMException('Aborted','AbortError');}])await withFetch(stub,async()=>assert.equal((await loadNews({},options())).items,undefined));
});
for(const path of ['/summary','/news'])for(const method of ['GET','POST'])test('deployed-handler contract '+method+' '+path+' voices Telegram, not turnout',async()=>{
 const calls=[];await withFetch(async url=>{calls.push(url);return new Response(syntheticTelegram(channelOf(url)),{headers:{'Content-Type':'text/html'}});},async()=>{
  const r=await worker.fetch(workerRequest(path+'?url=https://unrelated.example&root=/88&channel=other',{method,...(method==='POST'?{headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'next=hangup&source=other'}:{})}),{...workerEnv,YEMOT_ROOT:'/'});
  const text=await r.text();assert.equal(r.headers.get('X-Election-News-State'),'ready');assert.ok(text.endsWith('&go_to_folder=/'));assert.doesNotMatch(text,/אחוז ההצבעה הארצי|unrelated/);assert.equal(calls.length,3);assert.ok(calls.every(url=>url.startsWith('https://t.me/s/')));
 });
});
