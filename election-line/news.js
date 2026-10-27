import {parseTelegram,decodeEntities} from './telegram.js';
/** Public Telegram channels selected by the line owner. No login or API token. */
const CREDIT = 'העדכונים מתוך ערוצי הטלגרם הציבוריים, פרטי המקור נאמרו לפני כל הודעה';
const SOURCES = [
  {id:'now14', voice:'ערוץ ארבע עשרה', aliases:['ערוץ14','עכשיו14','חדשות14','14','now14','c14news','now14israel'], channels:['c14news','now14israel']},
  {id:'yinon', voice:'ערוץ ינון מגל', aliases:['ינוןמגל','yinonews','yinonewsינוןמגל','ינוןמגלבטלגרם'], channels:['yinonews']},
  {id:'amit', voice:'ערוץ עמית סגל', aliases:['עמיתסגל','amitsegal','עמיתסגלבטלגרם'], channels:['amitsegal']}
];
export const NEWS_CHANNELS = SOURCES.map(s=>({id:s.id,channels:[...s.channels]}));
const nameKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9\u05d0-\u05ea]/g, '');
function sourceOf(item) {
  const name=nameKey(item.source);
  const byName=SOURCES.find(s=>s.aliases.includes(name));
  try {
    const url=new URL(item.url);
    if(!['t.me','telegram.me'].includes(url.hostname.toLowerCase()))return byName || null;
    const parts=url.pathname.split('/').filter(Boolean);if(parts[0]==='s')parts.shift();
    const byUrl=SOURCES.find(s=>s.channels.includes(String(parts[0]||'').toLowerCase()));
    if(byName && byUrl && byName.id!==byUrl.id)return null;
    return byName || byUrl || null;
  } catch {return byName || null;}
}
export function speechText(value) {
  return String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ')
    .replace(/&(?:#x[0-9a-f]+|#\d+|[a-z]+);/gi,entity=>decodeEntities(entity))
    .replace(/https?:\/\/\S+/gi,' ').replace(/@[a-z0-9_]+/gi,' ')
    .replace(/(\d)\.(?=\d)/g,'$1 נקודה ').replace(/%/g,' אחוזים ')
    .replace(/\./g,', ').replace(/[\\"'`=\-\u05be\u2010-\u2015<>|&]/g,' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufe0f]/g,' ')
    .replace(/\p{Extended_Pictographic}/gu,' ')
    .replace(/\s+/g,' ').trim();
}
export function selectNews(data, now=Date.now()) {
  if(!data || !Array.isArray(data.items) || data.items.length>5000)throw new Error('upstream_shape');
  const candidates=[];
  for(const item of data.items) {
    if(!item || typeof item.source!=='string' || typeof item.date!=='string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(item.date))continue;
    const source=sourceOf(item),at=Date.parse(item.date);
    if(!source || !Number.isFinite(at) || at>now+300000 || now-at>86400000)continue;
    const title=speechText(typeof item.title==='string'?item.title:''),summary=speechText(typeof item.summary==='string'?item.summary:'');
    let text=summary.startsWith(title)?summary:title+(summary?', '+summary:'');
    const words=text.trim().split(/\s+/);
    text=words.slice(0,70).join(' ')+(words.length>70?', המשך ההודעה בערוץ':'');
    if(!/[\u05d0-\u05ea]/.test(text) || text.split(/\s+/).some(word=>word.length>200))continue;
    candidates.push({source:source.id,voice:source.voice,at,text});
  }
  candidates.sort((a,b)=>b.at-a.at);
  const counts={},seen=new Set(),items=[];
  for(const item of candidates) {
    const key=item.text.replace(/[^a-z0-9\u05d0-\u05ea]/gi,'');
    if((counts[item.source]||0)>=4 || seen.has(key))continue;
    counts[item.source]=(counts[item.source]||0)+1;seen.add(key);items.push(item);
  }
  return {items,counts};
}
function numberWords(n) {
  const ones=['אפס','אחת','שתיים','שלוש','ארבע','חמש','שש','שבע','שמונה','תשע'];
  const teens=['עשר','אחת עשרה','שתים עשרה','שלוש עשרה','ארבע עשרה','חמש עשרה','שש עשרה','שבע עשרה','שמונה עשרה','תשע עשרה'];
  if(n<10)return ones[n];if(n<20)return teens[n-10];
  return ['', '', 'עשרים','שלושים','ארבעים','חמישים'][Math.floor(n/10)]+(n%10?' ו'+ones[n%10]:'');
}
const dateParts = at => Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
export function clockSpeech(at, now=Date.now()) {
  const p=dateParts(at),today=dateParts(now),h=Number(p.hour),m=Number(p.minute);
  const hours=['שתים עשרה','אחת','שתיים','שלוש','ארבע','חמש','שש','שבע','שמונה','תשע','עשר','אחת עשרה'];
  const period=h===0?'בלילה':h<6?'לפנות בוקר':h<12?'בבוקר':h===12?'בצהריים':h<17?'אחרי הצהריים':h<23?'בערב':'בלילה';
  const minutes=m===0?'':m===15?' ורבע':m===30?' וחצי':' ו'+numberWords(m)+' דקות';
  const sameDay=p.year+p.month+p.day===today.year+today.month+today.day;
  const yesterday=dateParts(Date.UTC(Number(today.year),Number(today.month)-1,Number(today.day)-1,12));
  const previousDay=p.year+p.month+p.day===yesterday.year+yesterday.month+yesterday.day;
  return (sameDay?'':previousDay?'אתמול, ':'בתאריך '+Number(p.day)+' ל'+Number(p.month)+', ')+hours[h%12]+minutes+' '+period;
}
function chunks(text) {
  const result=[];let words=[];
  for(const word of speechText(text).split(/\s+/)) {
    if(word.length>200)throw new Error('speech_word');
    if(words.length && (words.length>=85 || words.join(' ').length+word.length+1>700)){result.push(words.join(' '));words=[];}
    if(word)words.push(word);
  }
  if(words.length)result.push(words.join(' '));return result;
}
export function renderNews(result, root, now=Date.now()) {
  let text;
  if(!result.items)text='עדכוני החדשות אינם זמינים כרגע, אנא נסו שוב מאוחר יותר';
  else if(!result.items.length)text='לא נמצאו כרגע עדכונים מהיממה האחרונה משלושת המקורות שנבחרו';
  else text=(result.stale?'חלק מהמקורות אינם זמינים, מושמע גם עותק קודם שהתקבל בדקות האחרונות, ':'')+(result.partial?'חלק מערוצי החדשות אינם זמינים כרגע, ':'')+'להלן קטעי העדכונים האחרונים, '+result.items.map(item=>clockSpeech(item.at,now)+' מ'+item.voice+', '+item.text).join(', ')+', '+CREDIT;
  return 'id_list_message='+chunks(text).map(part=>'t-'+part).join('.')+'&go_to_folder='+root;
}
const cacheKey=(origin,name)=>new Request(origin+'/__internal/telegram-news-v2/'+name);
async function cacheRead(cache,key) {try{const r=await cache?.match(key);return r?await r.json():null;}catch{return null;}}
async function cacheWrite(cache,key,value,ttl=300) {try{if(cache)await cache.put(key,new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age='+ttl}}));}catch{}}
export async function readNewsStatus(env,origin,cache=globalThis.caches?.default) {
  return await cacheRead(cache,cacheKey(origin,'status')) || {state:'not_checked',provider:'telegram_public'};
}
async function loadChannel(source,channel,{origin,readText,cache,now},timeoutMs) {
  const key=cacheKey(origin,channel),stored=await cacheRead(cache,key);
  const valid=stored && Number.isFinite(stored.fetchedAt) && stored.fetchedAt<=now && now-stored.fetchedAt<=300000 && Array.isArray(stored.items) && stored.items.length<=4 && stored.items.every(item=>item && item.source===source.id && item.voice===source.voice && Number.isFinite(item.at) && item.at<=now+300000 && typeof item.text==='string' && item.text.length<=15000);
  const recent=valid?{...stored,items:stored.items.filter(item=>now-item.at<=86400000)}:null;
  if(recent && now-stored.fetchedAt<30000)return {...recent,state:recent.items.length?'ready':'empty',channel};
  const previous=await cacheRead(cache,cacheKey(origin,channel+'-error'));
  if(previous && Number.isFinite(previous.checkedAt) && now-previous.checkedAt>=0 && now-previous.checkedAt<10000)return recent?{...recent,stale:true,state:'cached',channel}:{state:previous.state,channel};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetch('https://t.me/s/'+channel,{headers:{Accept:'text/html','User-Agent':'Election-Phone-Line/1.0'},redirect:'manual',signal:controller.signal});
    if([401,403].includes(response.status))throw new Error('authentication_required');
    if(response.status>=300 && response.status<400)throw new Error('upstream_redirect');
    if(!response.ok)throw new Error('upstream_http');
    if(!/^text\/html(?:;|$)/i.test(response.headers.get('Content-Type')||''))throw new Error('upstream_type');
    const parsed=parseTelegram(await readText(response,1500000),channel);
    const selected=selectNews(parsed,now),record={items:selected.items,fetchedAt:now,posts:parsed.posts};
    await cacheWrite(cache,key,record);
    return {...record,state:record.items.length?'ready':'empty',channel};
  } catch(error) {
    const state=['authentication_required','upstream_redirect','upstream_type','upstream_shape'].includes(error.message)?error.message:'unavailable';
    await cacheWrite(cache,cacheKey(origin,channel+'-error'),{state,checkedAt:now},10);
    return recent?{...recent,stale:true,state:'cached',channel}:{state,channel};
  } finally {clearTimeout(timer);}
}
export async function loadNews(env,{origin,readText,cache=globalThis.caches?.default,now=Date.now()}={}) {
  // Addresses are fixed here, never taken from caller parameters or obsolete site credentials.
  const options={origin,readText,cache,now};
  const results=await Promise.all(SOURCES.map(async source=>{
    let result=await loadChannel(source,source.channels[0],options,3500);
    if(source.channels.length>1 && (!result.items?.length || result.stale)) {
      const fallback=await loadChannel(source,source.channels[1],options,2500);
      if(fallback.items?.length && !fallback.stale || !result.items)result={...fallback,fallback:true};
    }
    return result;
  }));
  const available=results.filter(r=>Array.isArray(r.items)),items=available.flatMap(r=>r.items).sort((a,b)=>b.at-a.at);
  const seen=new Set(),unique=items.filter(item=>{const key=item.text.replace(/[^a-z0-9\u05d0-\u05ea]/gi,'');if(seen.has(key))return false;seen.add(key);return true;});
  const state=!available.length?'unavailable':available.length<3?'partial':available.some(r=>r.stale)?'cached':unique.length?'ready':'empty';
  const channels=Object.fromEntries(SOURCES.map((source,i)=>[source.id,{channel:results[i].channel,state:results[i].state,items:results[i].items?.length||0,fallback:!!results[i].fallback,...(results[i].items?.length?{newestAt:new Date(results[i].items[0].at).toISOString()}:{})}]));
  await cacheWrite(cache,cacheKey(origin,'status'),{state,provider:'telegram_public',checkedAt:now,items:unique.length,channels},300);
  return {state,...(available.length?{items:unique}:{}),channels,partial:available.length>0&&available.length<3,stale:available.some(r=>r.stale)};
}
