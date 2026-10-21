import fs from 'node:fs/promises';
import path from 'node:path';

export function beijingLogTime(date=new Date()){
 return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date);
}

export function beijingPrefix(date=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
 return p.month+p.day+'-'+p.hour+p.minute;
}
export async function createRunDirectory(root,label,started=new Date()){
 await fs.mkdir(root,{recursive:true});
 const safe=label.replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,40);
 for(let n=1;;n++){
  const dir=path.join(root,beijingPrefix(started)+'-'+safe+'-第'+String(n).padStart(2,'0')+'次');
  try{await fs.mkdir(dir);return dir;}catch(e){if(e.code!=='EEXIST')throw e;}
 }
}
export function createEvidenceRecorder(dir,log=()=>{}){
 let sequence=0;const evidence=[];
 async function capture(page,step){
  const stamp=beijingPrefix(),stem=stamp+'-'+String(++sequence).padStart(2,'0')+'-'+step.replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,50);
  const snapshot=()=>page.evaluate(()=>({url:location.href,text:(document.querySelector('main')||document.body).innerText,dialogs:[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map(e=>e.innerText),editors:[...document.querySelectorAll('[contenteditable="true"]')].map(e=>e.innerText)}));
  const before=await snapshot();let state=stem+'.json';
  await fs.writeFile(path.join(dir,state),JSON.stringify({time:new Date().toISOString(),...before},null,2));
  try{await page.screenshot({path:path.join(dir,stem+'.png'),timeout:15000});}
  catch(error){
   if(!error.message.includes('Timeout'))throw error;
   const supported=await page.evaluate(()=>Boolean(window.__OPENWORK_ELECTRON__?.windowControl?.toggleMaximize));
   if(!supported)throw error;
   const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
   log('截图超时','通过客户端窗口接口重绘并还原大小后重试一次');
   await page.evaluate(async()=>{
    const c=window.__OPENWORK_ELECTRON__.windowControl,original=await c.getChromeState();
    try{await c.toggleMaximize();}finally{if((await c.getChromeState()).maximized!==original.maximized)await c.toggleMaximize();}
   });
   await page.waitForFunction(v=>innerWidth===v.width&&innerHeight===v.height,viewport,{timeout:5000});
   const after=await snapshot();
   if(after.url!==before.url)throw Error('截图重试期间页面已切换，保留现场');
   state=stem+'-重绘后.json';
   await fs.writeFile(path.join(dir,state),JSON.stringify({time:new Date().toISOString(),...after},null,2));
   await page.screenshot({path:path.join(dir,stem+'.png'),timeout:15000});
  }
  const item={time:new Date().toISOString(),step,screenshot:stem+'.png',state};evidence.push(item);return item;
 }
 return {capture,evidence};
}
