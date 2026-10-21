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
  // All Trace entrances use the vendored 8770 viewer, independent of its server.
  const main=document.querySelector('main');main.style.maxWidth='none';
  const oldTimeline=main.lastElementChild;oldTimeline.remove();
  const banner=document.createElement('p');banner.textContent='运行结论：'+job.status+'；内容断言 '+(job.result?.checks||[]).filter(c=>c.category!=='skill-invocation'&&c.pass).length+'/'+(job.result?.checks||[]).filter(c=>c.category!=='skill-invocation').length+'；Skill断言 '+trace.summary.passed+'/'+trace.summary.total+'。模型步骤成功不等于全部验收通过。';main.prepend(banner);
  const viewerUrl='/traces/'+encodeURIComponent(id)+'/observatory';
  const available=await fetch(viewerUrl,{cache:'no-store'});
  if(available.ok){const frame=document.createElement('iframe');frame.title='Trace Observatory';frame.setAttribute('sandbox','allow-scripts allow-downloads');frame.style.cssText='width:100%;height:1100px;border:1px solid #d9e1e8';frame.src=viewerUrl;main.append(frame);}
  else{const warning=document.createElement('p');warning.className='result-fail';warning.textContent='Trace 观察台尚未加载：请关闭旧测试控制台并重新运行启动测试平台.cmd。原始断言和 Trace 下载仍可查看。';main.append(warning);}
  const blobUrl=URL.createObjectURL(new Blob([JSON.stringify(trace,null,2)],{type:'application/json;charset=utf-8'}));
  const download=document.querySelector('a[download]');download.href=blobUrl;download.download=trace.sessionId+'-trace.json';
  window.addEventListener('pagehide',()=>URL.revokeObjectURL(blobUrl),{once:true});
 }
}
