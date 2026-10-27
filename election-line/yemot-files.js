import {clockSpeech,speechText} from './news.js';

const API='https://www.call2all.co.il/ym/api/';
const OWNER='election-line-news-v1';
export const PLAYER_INTRO='לעדכון הקודם הקישו ארבע, לעדכון הבא הקישו שש, לשמיעה חוזרת הקישו חמש, ולתפריט הראשי הקישו אפס';
export function fileModeConfigured(env) {return typeof env.YEMOT_API_KEY==='string' && !!env.YEMOT_API_KEY.trim();}
const playerPath=root=>(root==='/'?'':root)+'/1/1';
export function playerConfig(root) {
  if(!(root==='/' || /^\/[0-9]+(?:\/[0-9]+)*$/.test(root)))throw new Error('configuration');
  return {type:'playfile',title:'עדכוני חדשות',start:'min',client_selection:'no',play_beep:'no',
    control_play4:'minus',control_play6:'next',control_play5:'restart',
    control_play0:'go_to_folder',playfile_control_play_0_goto:root,
    'control_play#':'go_to_folder','playfile_control_play_#_goto':root,
    'control_play*':'go_to_folder','playfile_control_play_*_goto':root,
    playfile_end_goto:root,playfile_error_goto:root};
}
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
export async function buildNewsFiles(data,root,now=Date.now()) {
  const config=playerConfig(root);
  if(!Array.isArray(data.items)||!data.items.length||data.items.length>12)throw new Error('no_news');
  const items=[...data.items].sort((a,b)=>b.at-a.at);
  const files=items.map((item,i)=>{
    if(!item || !Number.isFinite(item.at) || item.at>now+300000 || now-item.at>86400000 || !['ערוץ ינון מגל','ערוץ עמית סגל','ערוץ ארבע עשרה'].includes(item.voice) || typeof item.text!=='string' || item.text.length>15000)throw new Error('no_news');
    return {name:String(i).padStart(3,'0')+'.tts',contents:speechText(clockSpeech(item.at,now)+' מ'+item.voice+', '+item.text)};
  });
  const intro=(data.stale?'חלק מהמקורות אינם זמינים, מושמע גם עותק מהדקות האחרונות, ':'')+(data.partial?'חלק מערוצי החדשות אינם זמינים, ':'')+PLAYER_INTRO;
  const fingerprint=await digest(JSON.stringify({version:OWNER,root,config,intro,files}));
  const generation=BigInt('0x'+fingerprint.slice(0,20)).toString().padStart(25,'0');
  const parent=playerPath(root),folder=parent+'/'+generation;
  return {parent,folder,fingerprint,config,files:[{name:'M0000.tts',contents:intro},...files],count:items.length};
}
const readCache=async(cache,key)=>{try{const r=await cache?.match(key);return r?await r.json():null;}catch{return null;}};
const writeCache=async(cache,key,value)=>{try{if(cache)await cache.put(key,new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300'}}));}catch{}};
async function keys(env,origin,root) {
  const token=env.YEMOT_API_KEY?.trim();
  if(!token || token.length>4096 || /[\r\n]/.test(token))throw new Error('configuration');
  const hash=await digest(token+'\n'+root);
  return {token,key:new Request(origin+'/__internal/yemot-news-files-v1/'+hash)};
}
export async function readNewsFilesStatus(env,origin,root,cache=globalThis.caches?.default) {
  if(!fileModeConfigured(env))return {configured:false,state:'not_configured',player:playerPath(root)};
  try {const {key}=await keys(env,origin,root);return {configured:true,player:playerPath(root),...(await readCache(cache,key)||{state:'not_checked'})};}
  catch{return {configured:false,state:'configuration',player:playerPath(root)};}
}
export async function lastReadyNewsFiles(env,origin,root,{cache=globalThis.caches?.default,now=Date.now()}={}) {
  if(!fileModeConfigured(env))return null;
  try {
    const {key}=await keys(env,origin,root),ready=await readCache(cache,new Request(key.url+'-ready'));
    return ready?.state==='ready' && ready.target===playerPath(root) && Number.isFinite(ready.checkedAt) && now-ready.checkedAt>=0 && now-ready.checkedAt<=300000 ? ready : null;
  }catch{return null;}
}
async function uploadBatch(files,upload,controller) {
  let cursor=0,error=null;
  await Promise.all(Array.from({length:6},async()=>{
    while(cursor<files.length && !error) {
      const file=files[cursor++];
      try{await upload(file);}catch(e){error=e;controller.abort();}
    }
  }));
  if(error)throw error;
}
export async function syncNewsFiles(data,env,{origin,root,readText,cache=globalThis.caches?.default,now=Date.now()}={}) {
  if(!fileModeConfigured(env))return {state:'not_configured'};
  let auth,plan;
  try{auth=await keys(env,origin,root);plan=await buildNewsFiles(data,root,now);}catch(e){return {state:e.message==='no_news'?'no_news':'configuration'};}
  const previous=await readCache(cache,auth.key);
  if(previous?.state==='ready' && previous.fingerprint===plan.fingerprint && previous.target===plan.parent && Number.isFinite(previous.checkedAt) && now-previous.checkedAt>=0 && now-previous.checkedAt<30000)return previous;
  const leaseKey=new Request(auth.key.url+'-lease-'+plan.fingerprint),lease=await readCache(cache,leaseKey);
  if(Number.isFinite(lease?.checkedAt) && now-lease.checkedAt>=0 && now-lease.checkedAt<25000)return {state:'refreshing'};
  // Best-effort per-edge coordination. Duplicate cold starts remain safe because snapshots are immutable.
  await writeCache(cache,leaseKey,{checkedAt:now});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),22000);
  let phase='read_manifest',uploaded=0;
  async function api(action,body,allowMissing=false) {
    const r=await fetch(API+action,{method:'POST',headers:{Authorization:auth.token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body),redirect:'manual',signal:controller.signal});
    if(!r.ok || r.status>=300)throw Object.assign(new Error('sync_failed'),{apiHttp:r.status});
    const result=JSON.parse(await readText(r,65536));
    const missing=result.file?.exists===false || Array.isArray(result.file)&&result.file[0]?.exists===false || result.responseStatus==='ERROR'&&/file (?:does not exist|not found)/i.test(String(result.message));
    if(allowMissing && missing)return null;
    if(result.responseStatus!=='OK')throw Object.assign(new Error('sync_failed'),{apiStatus:['ERROR','FORBIDDEN','EXCEPTION'].includes(result.responseStatus)?result.responseStatus:'INVALID',...(Number.isInteger(result.messageCode)?{apiCode:result.messageCode}:{})});
    return result;
  }
  const what=name=>'ivr2:'+plan.folder+'/'+name;
  try {
    const existing=await api('GetTextFile',{what:what('news-ready.json')},true);
    let ready=false;
    if(existing) {
      const marker=JSON.parse(existing.contents);
      if(marker.owner!==OWNER || marker.fingerprint!==plan.fingerprint || marker.count!==plan.count || marker.folder!==plan.folder)throw new Error('sync_failed');
      ready=true;
    }
    if(!ready) {
      // Existing playback continues from its current snapshot until the next one is complete.
      phase='create_player';
      await api('UpdateExtension',{path:'ivr2:'+plan.parent,...plan.config});
      phase='create_snapshot';
      await api('UpdateExtension',{path:'ivr2:'+plan.folder,...plan.config});
      phase='upload_tts';
      await uploadBatch(plan.files,async file=>{await api('UploadTextFile',{what:what(file.name),contents:file.contents});uploaded++;},controller);
      phase='publish_marker';
      await api('UploadTextFile',{what:what('news-ready.json'),contents:JSON.stringify({owner:OWNER,fingerprint:plan.fingerprint,count:plan.count,folder:plan.folder})});
    }
    // Publish the new set only after every TTS file and the completion marker succeeded.
    phase='upload_intro';
    await api('UploadTextFile',{what:'ivr2:'+plan.parent+'/M0000.tts',contents:plan.files[0].contents});
    phase='publish_player';
    await api('UpdateExtension',{path:'ivr2:'+plan.parent,...plan.config,folder_to_play:plan.folder.slice(1)});
    const state={state:'ready',target:plan.parent,fingerprint:plan.fingerprint,count:plan.count,checkedAt:now};
    await writeCache(cache,auth.key,state);await writeCache(cache,new Request(auth.key.url+'-ready'),state);return state;
  }catch(error){
    const state={state:'sync_failed',phase,uploaded,reason:controller.signal.aborted?'timeout_or_cancelled':'api_error',...(Number.isInteger(error.apiHttp)?{apiHttp:error.apiHttp}:{}),...(error.apiStatus?{apiStatus:error.apiStatus}:{}),...(Number.isInteger(error.apiCode)?{apiCode:error.apiCode}:{}),checkedAt:now};await writeCache(cache,auth.key,state);return state;
  }finally{clearTimeout(timer);}
}
