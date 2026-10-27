import fs from 'node:fs';
const base=(process.env.ELECTION_WORKER_URL || 'https://elections-2026-yemot.mh0774020798.workers.dev').replace(/\/$/, '');
const root=process.env.YEMOT_ROOT || '/';
const child=key=>(root==='/'?'':root)+'/'+key;
const parent=root.slice(0,root.lastIndexOf('/')) || '/';
const topics=['summary','turnout','exitpolls','results','parties'];
const cases=[];
const speech=text=>text.startsWith('id_list_message=t-')&&text.endsWith('&go_to_folder='+root)&&text.includes('הנתונים באדיבות אתר בחירות 2026')&&!/לא ניתן לקבל|אינם זמינים|מושמע עותק/.test(text);
const menu=text=>text.startsWith('read=t-')&&text.endsWith('=election_choice,no,1,1,7,No,yes,no,,0123459')&&(root!=='/'||text.includes('להשמעת התפריט מחדש'));
cases.push({name:'health',path:'/health',test:text=>JSON.parse(text).ok===true});
cases.push({name:'menu',path:'/menu',test:menu});
const news=text=>speech(text)&&text.includes('מערוץ')&&!text.includes('אחוז ההצבעה הארצי');
for(const topic of topics)cases.push({name:topic+' GET',path:'/'+topic,test:topic==='summary'?news:speech});
for(const topic of topics)cases.push({name:topic+' POST',path:'/'+topic+'?root=%2F77&next=hangup',method:'POST',body:'topic=health&root=%2F77&next=hangup',test:topic==='summary'?news:speech});
for(const key of ['0','1','2','3','4','5','9'])cases.push({name:'key '+key,path:'/menu',method:'POST',body:'election_choice='+key,test:text=>text==='go_to_folder='+(['0','9'].includes(key)?parent:child(key))});
cases.push({name:'root menu',path:'/',test:menu});
cases.push({name:'POST menu',path:'/menu',method:'POST',body:'',test:menu});
cases.push({name:'invalid choice',path:'/menu?election_choice=8',test:menu});
cases.push({name:'JSON choice',path:'/menu',method:'POST',type:'application/json',body:JSON.stringify({election_choice:4}),test:text=>text==='go_to_folder='+child('4')});
cases.push({name:'unknown route',path:'/internal/tick',status:404,test:text=>text==='Not found'});
cases.push({name:'unsupported method',path:'/menu',method:'PUT',status:405,test:text=>text==='Method not allowed'});
const results=new Array(cases.length);
let cursor=0,complete=0;
async function check(){while(cursor<cases.length){const index=cursor++,c=cases[index],at=Date.now();try{
 const r=await fetch(base+c.path,{method:c.method||'GET',headers:{'User-Agent':'yemot-core-api/1.0','Accept':'text/plain, application/json',...(c.method==='POST'?{'Content-Type':c.type||'application/x-www-form-urlencoded'}:{})},...(c.body!==undefined?{body:c.body}:{}),signal:AbortSignal.timeout(30000)});
 const body=await r.text(),phoneSafe=c.path==='/health'?null:!/[\\"'`]/.test(body);results[index]={name:c.name,path:c.path,method:c.method||'GET',http:r.status,ok:r.status===(c.status||200)&&c.test(body)&&(!c.name.startsWith('parties')||phoneSafe),...(r.headers.get('X-Election-News-State')==='authentication_required'?{blocked:'site_authentication_required'}:{}),phoneSafe,seconds:Number(((Date.now()-at)/1000).toFixed(3)),contentType:r.headers.get('Content-Type'),body};
 }catch(e){results[index]={name:c.name,path:c.path,ok:false,error:e.message,seconds:Number(((Date.now()-at)/1000).toFixed(3))};}
 complete++;if(complete%5===0)console.log(JSON.stringify({completed:complete,total:cases.length,passed:results.filter(x=>x?.ok).length}));
}}
await Promise.all(Array.from({length:4},check));
const report={checkedAt:new Date().toISOString(),workerUrl:base,yemotRoot:root,scope:'Real HTTPS checks; site-news access may be blocked by its login requirement; no telephone audio test',client:'yemot-core-api/1.0',ok:results.every(x=>x.ok),total:results.length,passed:results.filter(x=>x.ok).length,blocked:results.filter(x=>x.blocked).length,checks:results};
fs.writeFileSync(new URL('../evidence/deployed-check.json', import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,checks:results.map(({body,...rest})=>({...rest,...(!rest.ok&&body?{body}:{} )}))},null,2));
if(!report.ok)process.exitCode=report.checks.every(x=>x.ok||x.blocked)?2:1;
