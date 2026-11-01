import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Existing definitions are hashed inside the renderer. Their instructions and
// credentials must not leave the client merely to establish a cleanup baseline.
export async function readAutomation(page,owned){
 return page.evaluate(async owned=>{
  const invoke=window.__MOBILEWORK__.invoke,auth=await invoke('auth:current'),accountId=auth.account.id;
  if(owned&&accountId!==owned.accountId)throw Error('自动化账号已变化，保留本轮计划');
  const {jobs}=await invoke('automation:list',{accountId});
  const hashes=[];let job=null;
  for(const item of jobs){
   if(owned&&!owned.beforeIds.includes(item.id)&&owned.names.includes(item.name)){
    if(job)throw Error('本轮自动化计划不唯一，未操作');
    job=item;continue;
   }
   const definition=Object.fromEntries(Object.entries(item).filter(([key])=>!['updatedAt','lastRunAt','sessionIds','autoWorkspaceId','executionWorkspaceId'].includes(key)).sort(([a],[b])=>a.localeCompare(b)));
   const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(definition)));
   hashes.push({id:item.id,hash:Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('')});
  }
  const {runs}=await invoke('automation:runs',{accountId});
  return {accountId,ids:jobs.map(j=>j.id),hashes:hashes.sort((a,b)=>a.id.localeCompare(b.id)),job,runs:owned?runs.filter(r=>r.jobId===(job?.id||owned.id)):[]};
 },owned||null);
}

export async function disableOwnedAutomation(page,owned){
 const state=await readAutomation(page,owned),job=state.job;
 if(!job||owned.id&&job.id!==owned.id)throw blocked('未找到本轮唯一自动化计划，未修改其他任务');
 await page.evaluate(async({accountId,jobId})=>{
  await window.__MOBILEWORK__.invoke('automation:setEnabled',{accountId,jobId,enabled:false});
 },{accountId:owned.accountId,jobId:job.id});
 const confirmed=(await readAutomation(page,owned)).job;
 if(confirmed.enabled)throw blocked('测试计划关闭未生效，不继续试运行或交接');
 owned.id=job.id;owned.creating=false;
 return confirmed;
}

export async function waitAutomation(page,predicate,message,{timeoutMs=60000}={}){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){const value=await predicate();if(value)return value;await pause(300);}
 throw blocked(message);
}

export async function findAutomationSession(page,owned){
 const {job}=await readAutomation(page,owned);
 if(!job||job.id!==owned.id)throw blocked('试运行计划归属已变化');
 const links=(job.sessionIds||[]).filter(link=>!owned.beforeSessions.includes(link.sessionId));
 if(links.length>1)throw blocked('本轮自动化出现多个新Session，未选择任意会话');
 return links[0];
}

// Used by normal cleanup and by the existing forced-stop recovery. A product
// trial run links its Session before sending; an empty list is not completion.
export async function settleOwnedAutomation(page,owned,{allowAbort=false}={}){
 if(!owned.runPending)return null;
 const state=await readAutomation(page,owned),link=await findAutomationSession(page,owned);
 const done=state.runs.find(r=>r.ts>=owned.runStartedAt&&(!link||r.sessionId===link.sessionId));
 if(done){owned.runPending=false;return link||null;}
 if(!allowAbort)throw blocked('自动化试运行尚未产生终态记录，保留计划及Session归属');
 if(!link)throw blocked('自动化仍在初始化且未关联Session，不能确认停止；保留归属等待恢复');
 const url=new URL(owned.originUrl);url.hash='/workspace/'+link.workspaceId+'/session/'+link.sessionId;
 const current=page.url();
 if(current!==owned.originUrl&&new URL(current).hash!=='#/automation'&&current!==url.href)throw blocked('自动化收尾页面已被用户切换，保留现场');
 if(current!==url.href){await page.evaluate(hash=>{location.hash=hash;},url.hash);await page.waitForURL(url.href);}
 const connection=await readEngineConnection(page),session=await engineRequest(connection,'/session/'+link.sessionId);
 if(session.id!==link.sessionId||!session.directory)throw blocked('自动化Session目录未确认');
 const route='?directory='+encodeURIComponent(session.directory);
 if(await engineRequest(connection,'/session/'+link.sessionId+'/abort'+route,{method:'POST'})!==true)throw blocked('自动化任务未确认停止');
 await waitAutomation(page,async()=>{
  if((await engineRequest(connection,'/session/status'+route))[link.sessionId]?.type==='busy')return false;
  return (await readAutomation(page,owned)).runs.some(r=>r.sessionId===link.sessionId&&r.ts>=owned.runStartedAt);
 },'自动化停止后尚未完成产品收尾，保留归属',{timeoutMs:30000});
 owned.runPending=false;
 return link;
}

export async function releaseAutomation(page,owned){
 if(owned.runPending)throw blocked('自动化后台尚未终态，不能移除计划并启动下一条');
 const {job}=await readAutomation(page,owned);
 if(owned.creating&&!job)throw blocked('自动化创建提交结果尚未确认，保留归属等待恢复');
 if(job){
  if(owned.id&&owned.id!==job.id)throw blocked('自动化计划ID与本轮登记不一致');
  await disableOwnedAutomation(page,owned);
  // The UI delete also deletes Sessions/workspaces. Remove only the schedule;
  // keep its actual run history, workspace, files and Session evidence.
  const result=await page.evaluate(({accountId,jobId})=>window.__MOBILEWORK__.invoke('automation:delete',{accountId,jobId}),{accountId:owned.accountId,jobId:job.id});
  if(result.ok!==true||(await readAutomation(page,owned)).job)throw blocked('本轮自动化计划移除未确认');
 }
 const after=await readAutomation(page,owned);
 if(JSON.stringify(after.hashes)!==JSON.stringify(owned.hashes))throw blocked('既有自动化定义发生变化，保留差异，不覆盖用户任务');
}
