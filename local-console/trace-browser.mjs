import {renderTrace} from './trace.mjs';
import {loadTraceData} from './trace-data.mjs';

export async function showBrowserTrace(id){
 document.querySelector('main').textContent='正在读取 Trace 记录…';
 let job={id,name:'运行记录'},trace,error;
 const read=async route=>{const res=await fetch(route,{cache:'no-store'});const data=await res.json();if(!res.ok)throw Error(data.error||'读取失败：HTTP '+res.status);return data;};
 try{
  if(!/^[\w-]+$/.test(id))throw Error('运行记录 ID 无效');
  job=await read('/api/jobs/'+encodeURIComponent(id));
  trace=await loadTraceData(job,{
   readSaved:name=>read('/artifacts/'+encodeURIComponent(id)+'/'+encodeURIComponent(name)),
   readLive:sessionId=>read('/sessions/'+encodeURIComponent(sessionId)+'/download')
  });
 }catch(e){error=e.message;}
 const doc=new DOMParser().parseFromString(renderTrace(job,trace,error),'text/html');
 document.title=doc.title;document.body.replaceChildren(...doc.body.childNodes);
 if(trace){
  const blobUrl=URL.createObjectURL(new Blob([JSON.stringify(trace,null,2)],{type:'application/json;charset=utf-8'}));
  const download=document.querySelector('a[download]');download.href=blobUrl;download.download=trace.sessionId+'-trace.json';
  window.addEventListener('pagehide',()=>URL.revokeObjectURL(blobUrl),{once:true});
 }
}
