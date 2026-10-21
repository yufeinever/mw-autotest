import {setTimeout as delay} from 'node:timers/promises';
import {readSessionLog} from '../local-console/session-log.mjs';
import {handleConfiguredDialog,waitStep} from './mobilework-run-policy.mjs';
import {PermissionEvents} from './mobilework-permission-events.mjs';
import {initializeTestPage} from './mobilework-initialize.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
export function createTaskControl({log=()=>{},url=process.env.MW_TASK_CONTROL_URL,token=process.env.MW_TASK_CONTROL_TOKEN}={}){
 return url&&token?new TaskControl({url,token,log}):null;
}
export class TaskControl {
 constructor({url,token,log=()=>{}}){this.url=url;this.token=token;this.log=log;this.held=false;this.sessionId=null;}
 async call(action,body={}){
  const response=await fetch(this.url+'/'+action,{method:'POST',headers:{'content-type':'application/json','x-task-token':this.token},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const data=await response.json();if(!response.ok)throw blocked(data.error||'任务调度器不可用');return data;
 }
 async acquire(page,phase){
  if(this.faulted)throw blocked('页面已在调度之外变化，不再操作客户端');
  if(this.held)return;
  const deadline=Date.now()+300000;let result;
  do{result=await this.call('acquire',{phase});if(result.granted)break;await delay(200);}while(Date.now()<deadline);
  if(!result.granted)throw blocked('等待客户端页面操作超时；没有操作其他任务');
  this.held=true;
  if(result.expectedUrl&&page.url()!==result.expectedUrl){this.faulted=true;throw blocked('客户端页面在调度之外被切换，保留现场，停止本任务的界面操作');}
 }
 async release(page,phase='WAITING_MODEL'){
  if(!this.held)return;
  await this.call('release',{url:page.url(),sessionId:this.sessionId,phase,...(this.connection?{runtime:this.connection}:{})});this.held=false;
 }
 async begin(page,{openComposer=true,stepInterval=0.5}={}){
  await this.acquire(page,'PREPARING');
  await this.call('checkpoint',{protocol:2});
  if(openComposer){
   const owned=/\/session\/ses_[A-Za-z0-9]+$/.test(page.url())?await this.call('is-managed',{url:page.url()}):{managed:false};
   await initializeTestPage(page,{stepInterval,managedSession:owned.managed,log:this.log});
  }
 }
 async assertNoDraft(page){
  const drafts=page.locator('[contenteditable="true"]').filter({visible:true});
  for(let i=0;i<await drafts.count();i++)if((await drafts.nth(i).innerText()).trim())throw blocked('当前有未发送草稿，保留草稿，不切换页面');
 }
 async checkpointDraft(owned){
  const {editor,...draft}=owned;await this.call('checkpoint',{draft});
 }
 async markSubmitting(){await this.call('checkpoint',{submitting:true});}
 async registerSession(page,sessionId){
  if(!/^ses_[A-Za-z0-9]+$/.test(sessionId)||!page.url().endsWith('/session/'+sessionId))throw blocked('不能登记不属于当前页面的会话');
  this.sessionId=sessionId;this.sessionUrl=page.url();
  await this.call('checkpoint',{sessionId,sessionUrl:this.sessionUrl});
 }
 async submitted(page,sessionId){
  if(this.connection)return;
  if(!/^ses_[A-Za-z0-9]+$/.test(sessionId)||!page.url().endsWith('/session/'+sessionId))throw blocked('不能登记不属于当前页面的会话');
  this.sessionId=sessionId;this.sessionUrl=page.url();
  // Credentials remain in this process only, never in scheduler state/reports.
  this.connection=await page.evaluate(async()=>{
   for(let n=0;n<40;n++){
    const i=await window.__OPENWORK_ELECTRON__.invokeDesktop('engineInfo');
    if(typeof i?.baseUrl==='string'&&i.baseUrl.trim()){
     const redactionSecrets=[];
     try{const data=await window.__MOBILEWORK__.invoke('models:list');for(const model of data.models||[])if(typeof model.apiKey==='string'&&model.apiKey)redactionSecrets.push(model.apiKey);}catch{}
     return {baseUrl:i.baseUrl,opencodeUsername:i.opencodeUsername,opencodePassword:i.opencodePassword,redactionSecrets};
    }
    await new Promise(r=>setTimeout(r,250));
   }
   throw Error('客户端引擎尚未就绪：缺少引擎地址；未重复发送任务');
  });
  const session=await this.get('/session/'+sessionId);
  if(session.id!==sessionId||typeof session.directory!=='string'||!session.directory)throw blocked('无法确认新会话及所属目录');
  this.directory=session.directory;this.log('等待模型处理',sessionId+'；页面已交还调度器');
  await this.release(page);
 }
 async get(route){
  const query=this.directory?'?directory='+encodeURIComponent(this.directory):'';
  const response=await fetch(this.connection.baseUrl.replace(/\/$/,'')+route+query,{headers:{Authorization:'Basic '+btoa(this.connection.opencodeUsername+':'+this.connection.opencodePassword)},signal:AbortSignal.timeout(15000)});
  if(!response.ok){
   let message='';try{const body=await response.json();message=body?.data?.message||'';}catch{}
   const patchPermissionError=route==='/permission'&&response.status===400&&/Expected JSON value/.test(message)&&/filePath/.test(message)&&/patch/.test(message);
   // Keep raw permission payloads (paths and file contents) out of reports.
   throw Object.assign(blocked('读取本任务引擎状态失败：HTTP '+response.status+'；接口 '+route+'；未切换其他任务的引擎'),{patchPermissionError});
  }return response.json();
 }
 async readLog(includeChildren=false){return readSessionLog({sessionId:this.sessionId,includeChildren,connection:this.connection});}
 async focus(page){
  await this.assertNoDraft(page);
  if(page.url()!==this.sessionUrl){
   await page.evaluate(url=>{location.hash=new URL(url).hash;},this.sessionUrl);
   await page.waitForURL(this.sessionUrl,{timeout:10000});
  }
  const data=await this.readLog(),user=data.messages.find(m=>m.info?.role==='user');
  const text=(user?.parts||[]).filter(p=>p.type==='text').map(p=>p.text||'').join('\n').trim();
  if(!text)throw blocked('本会话没有可核对的用户消息，不处理界面');
  // Do not treat a changed hash alone as proof that the new session rendered.
  // Skill chips are expanded to an English "Load [skill ...]" instruction in
  // Session messages, while the UI displays the original Chinese prompt.
  const signature=text.split(/\r?\n/).map(s=>s.trim()).find(s=>/[\u3400-\u9fff]/.test(s)&&s.length>=8)||text;
  await page.waitForFunction(expected=>{
   const normalized=s=>s.replace(/\s+/g,' ').trim();
   return normalized((document.querySelector('main:last-of-type')||document.body).innerText).includes(normalized(expected));
  },signature.slice(0,100),{timeout:15000});
  if(page.url()!==this.sessionUrl)throw blocked('页面已离开本任务会话');
 }
 async withUI(page,phase,action){
  if(this.faulted)throw blocked('页面已在调度之外变化，不再截图或点击其他会话');
  const alreadyHeld=this.held;
  if(!alreadyHeld)await this.acquire(page,phase);
  try{if(!alreadyHeld&&this.sessionId)await this.focus(page);return await action();}
  finally{if(!alreadyHeld&&!this.faulted)await this.release(page,phase==='EVIDENCE'?'VERIFYING':'WAITING_MODEL');}
 }
 async pendingInteractions(){
  const questions=await this.get('/question'),since=this.permissionEvents?.checkpoint()??null;
  let permissions,permissionApiUnavailable=false;
  try{
   permissions=await this.get('/permission');
   if(this.permissionEvents?.seed(permissions,since))permissions=this.permissionEvents.snapshot()??permissions;
  }
  catch(error){
   if(!error?.patchPermissionError)throw error;
   permissions=this.permissionEvents?.snapshot();
   // An empty event cache cannot prove that an unreadable listing is empty.
   if(!permissions?.length)throw error;
   permissionApiUnavailable=true;
  }
  if(!Array.isArray(questions)||!Array.isArray(permissions))throw blocked('引擎待处理交互格式不支持，保留会话');
  const result=[...questions.map(q=>({...q,kind:'question'})),...permissions.map(q=>({...q,kind:'permission'}))]
   .filter(q=>q.sessionID===this.sessionId).map(q=>{
    if(typeof q.id!=='string'||!q.id)throw blocked('待处理交互缺少请求ID，不能核对归属');
    return {...q,key:q.kind+':'+q.id,permissionEventFallback:permissionApiUnavailable&&q.kind==='permission'};
   });
  result.permissionApiUnavailable=permissionApiUnavailable;
  return result;
 }
 async wait(page,config,{timeoutMs,capture,log=this.log,interactionTimeoutMs=15000,permissionRecoveryMs=15000}){
  if(this.connection&&this.directory&&!this.permissionEvents){
   this.permissionEvents=new PermissionEvents({connection:this.connection,directory:this.directory,sessionId:this.sessionId});
   const ready=await this.permissionEvents.start();
   log('审批事件订阅',ready?'已连接本会话引擎；等待审批列表建立基线':'不可用，继续使用审批列表；不使用过期事件');
  }
  const deadline=Date.now()+timeoutMs,observed=new Map();let lastLog=0,permissionErrorSince=null;
  const reconcile=pending=>{
   const keys=new Set(pending.map(q=>q.key));
   for(const key of observed.keys())if(!keys.has(key)){log('交互请求已消失，继续等待模型',key);observed.delete(key);}
   for(const q of pending)if(!observed.has(q.key)){observed.set(q.key,{since:Date.now(),clicked:false});log('发现本会话待处理交互',q.key);}
  };
  while(Date.now()<deadline){
   try{
   const [states,pending]=await Promise.all([this.get('/session/status'),this.pendingInteractions(page)]);
   if(pending.permissionApiUnavailable&&!this.permissionFallbackLogged){log('审批列表400，使用本会话实时审批事件','已核对有效基线与连续连接；仍按真实请求ID和原DOM审批');this.permissionFallbackLogged=true;}
   reconcile(pending);
   if(pending.length){
    await this.withUI(page,'INTERACTING',async()=>{
     // A request may resolve while acquiring/focusing the shared page. Never
     // treat the pre-acquire API snapshot as proof that a DOM control exists.
     const current=await this.pendingInteractions(page);reconcile(current);
     if(!current.length)return;
     const kind=current.some(q=>q.kind==='permission')?'permission':'question';
     const targets=current.filter(q=>q.kind===kind);
     let eventFallback=targets.some(q=>q.permissionEventFallback);
     if(eventFallback&&targets.length!==1)throw blocked('审批列表异常且本会话有多个审批，无法唯一匹配页面，保留现场');
     const expected=targets.flatMap(q=>q.questions||[]).map(q=>q.question).filter(Boolean);
     if(kind==='question'&&!expected.length)throw blocked('待回答问题缺少可核对正文');
     const canAct=async()=>{
      if(page.url()!==this.sessionUrl)throw blocked('页面已离开本任务会话');
      const latest=await this.pendingInteractions(page);reconcile(latest);
      if(latest.permissionApiUnavailable){
       if(targets.length!==1)throw blocked('审批列表在操作前异常，无法唯一匹配原请求，保留现场');
       eventFallback=true;
      }
      return targets.every(q=>latest.some(item=>item.key===q.key));
     };
     // Successful permissions are not clicked again while engine state settles.
     // Questions may contain several cards under one request ID.
     let handled=false;
     if(!targets.some(q=>observed.get(q.key)?.clicked)){
      handled=await handleConfiguredDialog(page,config,capture,log,{kind,expectedQuestions:expected,canAct,
       expectedPermission:()=>eventFallback?{id:targets[0].id,sessionID:this.sessionId}:undefined});
      if(handled)for(const q of targets){const state=observed.get(q.key);if(state){state.since=Date.now();state.clicked=kind==='permission';}log('交互已点击，等待引擎确认',q.key);}
     }
     const latest=await this.pendingInteractions(page);reconcile(latest);
     for(const q of latest){
      const state=observed.get(q.key);
      if(Date.now()-state.since>=interactionTimeoutMs)throw blocked(`本会话交互持续未解决：${q.key}；${state.clicked?'已点击但引擎尚未确认':'限时重试后仍未识别对应控件'}，保留现场`);
      if(!handled&&!state.logged){log('交互尚未同步，交还页面后重试',q.key);state.logged=true;}
     }
    });
   }else if((states[this.sessionId]?.type||'idle')==='idle'){
    const data=await this.readLog(),last=data.messages.at(-1);
    if(last?.info?.error){await this.call('completed');throw Error('引擎会话错误：'+JSON.stringify(last.info.error));}
    const text=(last?.parts||[]).filter(p=>p.type==='text').map(p=>p.text||'').join('\n');
    if(last?.info?.role==='assistant'&&last.info.time?.completed&&last.info.finish&&last.info.finish!=='tool-calls'&&!(last.parts||[]).some(p=>p.type==='tool')&&text.trim()){await this.call('completed');return data;}
   }
   if(this.permissionFallbackLogged&&!pending.permissionApiUnavailable){log('审批接口已恢复','已重新核对本会话交互状态');this.permissionFallbackLogged=false;}
   permissionErrorSince=null;
   }catch(error){
    if(!error.patchPermissionError)throw error;
    if(permissionErrorSince===null){permissionErrorSince=Date.now();log('客户端补丁审批数据暂不可解析','/permission HTTP 400；限时重试，期间不点击、不判定完成');}
    if(Date.now()-permissionErrorSince>=permissionRecoveryMs)throw blocked('客户端补丁审批数据持续无法解析：/permission HTTP 400；也无可靠实时审批事件，不能确认待审批状态，保留会话');
   }
   if(Date.now()-lastLog>30000){log('等待本次模型完成',this.sessionId+'；未占用客户端页面');lastLog=Date.now();}
   await delay(1000);
  }
  throw blocked('等待会话超时；保留运行任务和证据，可强制停止本次会话');
 }
 async close(page){this.permissionEvents?.stop();if(this.held&&page&&!this.faulted)await this.release(page,'VERIFYING');}
}
