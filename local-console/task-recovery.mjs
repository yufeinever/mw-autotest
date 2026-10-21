import {chromium} from 'playwright-core';
import {setTimeout as delay} from 'node:timers/promises';
import {inspectPageHandoff} from '../scripts/mobilework-isolation.mjs';

export async function settleSession(page,job,connection,{allowAbort=false}={}){
 if(!job.sessionId)return !job.submissionPending;
 if(job.modelCompleted||job.sessionSettled)return true;
 if(!connection){
  // A default workspace or another task's page is not evidence of this
  // session's engine. Never abort using whichever engine happens to be open.
  if(!page.url().endsWith('/session/'+job.sessionId))throw Error('尚未取得本会话引擎连接，未操作其他会话');
  const info=await page.evaluate(()=>window.__OPENWORK_ELECTRON__.invokeDesktop('engineInfo'));
  connection={baseUrl:info?.baseUrl,opencodeUsername:info?.opencodeUsername,opencodePassword:info?.opencodePassword};
 }
 if(!connection.baseUrl)throw Error('本会话引擎未就绪');
 const base=connection.baseUrl.replace(/\/$/,''),headers={Authorization:'Basic '+btoa(connection.opencodeUsername+':'+connection.opencodePassword)};
 const request=async(route,method='GET')=>{
  const r=await fetch(base+route,{method,headers,signal:AbortSignal.timeout(5000)});
  if(!r.ok){
   let message='';try{message=(await r.json())?.data?.message||'';}catch{}
   throw Object.assign(Error('核对本会话接口失败 HTTP '+r.status),{patchPermissionError:route.startsWith('/permission?')&&r.status===400&&/Expected JSON value/.test(message)&&/filePath/.test(message)&&/patch/.test(message)});
  }return r.json();
 };
 const session=await request('/session/'+job.sessionId);
 if(session.id!==job.sessionId||!session.directory)throw Error('会话归属核对失败');
 const query='?directory='+encodeURIComponent(session.directory);
 const stopped=async()=>{
  const status=await request('/session/status'+query);
  if(!status||typeof status!=='object'||Array.isArray(status))throw Error('会话运行状态格式异常');
  return (status[job.sessionId]?.type||'idle')==='idle';
 };
 // After an acknowledged abort, the independent runtime state is the stop
 // proof. A broken permission-list serializer must not keep dead work alive.
 if(job.abortAcknowledged){if(await stopped()){job.sessionSettled=true;return true;}return false;}
 const state=async()=>{
  const [status,permissions,questions]=await Promise.all(['/session/status','/permission','/question'].map(r=>request(r+query)));
  if(!Array.isArray(permissions)||!Array.isArray(questions))throw Error('会话交互数据格式异常');
  return (status[job.sessionId]?.type||'idle')==='idle'&&![...permissions,...questions].some(q=>q.sessionID===job.sessionId);
 };
 let idle=false;
 try{idle=await state();}catch(e){if(!allowAbort||!e.patchPermissionError)throw e;}
 if(idle){
  if(job.abortAcknowledged){job.sessionSettled=true;return true;}
  const messages=await request('/session/'+job.sessionId+'/message'+query);
  const last=messages.at(-1);
  if(last?.info?.role==='assistant'&&(last.info.error||last.info.time?.completed&&last.info.finish&&last.info.finish!=='tool-calls')){
   job.sessionSettled=true;return true;
  }
 }
 if(!allowAbort||job.recoveryAbortAttempted)return false;
 job.recoveryAbortAttempted=true;
 if(await request('/session/'+job.sessionId+'/abort'+query,'POST')!==true)throw Error('客户端未确认停止本会话');
 job.abortAcknowledged=true;
 for(let i=0;i<10;i++){
  if(await stopped()){job.sessionSettled=true;job.recoveryAction='已停止本条关联会话并确认空闲；原用例结果不变';return true;}
  await delay(300);
 }
 return false;
}

export async function recoverJobPage(page,job,{connection,allowAbort=false,otherManagedSession=false}={}){
 if(!await settleSession(page,job,connection,{allowAbort}))return {ready:false,reason:job.submissionPending&&!job.sessionId?'发送已尝试但Session归属未确认，暂停后续任务':'本条会话尚未确认结束'};
 let handoff=await inspectPageHandoff(page,{owned:job.ownedDraft,allowRunning:otherManagedSession});
 // Some clients leave the permission card rendered after an acknowledged
 // abort. Only leave that exact, independently confirmed stopped session.
 // Never click its stale approval or navigate away from a user draft/modal.
 const staleApproval=handoff.reason==='当前页面仍有运行任务或交互'&&job.abortAcknowledged&&job.sessionSettled;
 const ownSelection=handoff.reason==='输入区仍有专家或团队选择，不能交接'&&job.submittedSelection?.length&&(job.modelCompleted||job.sessionSettled);
 if(!handoff.ready&&(staleApproval||ownSelection)&&page.url().endsWith('/session/'+job.sessionId)){
  const clean=await inspectPageHandoff(page,{allowRunning:staleApproval,allowedSelection:job.submittedSelection||[]});
  if(clean.ready){
   const button=page.getByRole('button',{name:'新建任务',exact:true}).filter({visible:true});
   if(await button.count()===1){await button.click({timeout:3000});await page.waitForURL(url=>!url.toString().endsWith('/session/'+job.sessionId),{timeout:5000});handoff=await inspectPageHandoff(page);job.recoveryAction=ownSelection?'确认本会话完成后退出本次专家选择页面，未更改其他会话':'确认本会话停止后退出残留审批页面，未点击旧审批';}
  }
 }
 return {...handoff,url:page.url()};
}
export async function recoverJob(job,{connection,allowAbort=false,jobs=[]}={}){
 const browser=await chromium.connectOverCDP('http://127.0.0.1:'+job.config.cdpPort,{timeout:5000});
 try{
  const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url().includes('MobileWork/resources/app-dist/index.html'));
  if(pages.length!==1)throw Error('未找到唯一客户端主界面');
  const page=pages[0],otherManagedSession=jobs.some(j=>j.id!==job.id&&j.status==='RUNNING'&&j.sessionUrl===page.url());
  return await recoverJobPage(page,job,{connection,allowAbort,otherManagedSession});
 }finally{await browser.close();}
}
