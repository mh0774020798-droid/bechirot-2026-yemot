import test from 'node:test';
import assert from 'node:assert/strict';
import {selectNews,clockSpeech,renderNews,speechText,loadNews,readNewsStatus} from '../news.js';
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
test('news: selected Telegram URL can identify the source',()=>assert.equal(selectNews({items:[item('טלגרם',{url:'https://t.me/s/amitsegal/100'})]},now).items[0].source,'amit'));
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
