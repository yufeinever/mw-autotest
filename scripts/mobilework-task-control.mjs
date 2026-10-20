import {setTimeout as delay} from 'node:timers/promises';
import {readSessionLog} from '../local-console/session-log.mjs';
import {handleConfiguredDialog} from './mobilework-run-policy.mjs';

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
 async begin(page,{openComposer=true}={}){
  await this.acquire(page,'PREPARING');
  // The previous managed session may still be running. Open a fresh composer
  // through the actual control, without aborting its model work.
  if(openComposer&&/\/session\/ses_[A-Za-z0-9]+$/.test(page.url())){
   const owned=await this.call('is-managed',{url:page.url()});
   if(owned.managed){
    await this.assertNoDraft(page);
    if(await page.getByRole('dialog').filter({visible:true}).count())throw blocked('已有任务出现对话框，保留现场，等待其交互处理后重试');
    await page.getByRole('button',{name:'新建任务',exact:true}).filter({visible:true}).click();
    await page.waitForURL(url=>! /\/session\/ses_[A-Za-z0-9]+$/.test(url.toString()),{timeout:10000});
   }
  }
 }
 async assertNoDraft(page){
  const drafts=page.locator('[contenteditable="true"]').filter({visible:true});
  for(let i=0;i<await drafts.count();i++)if((await drafts.nth(i).innerText()).trim())throw blocked('当前有未发送草稿，保留草稿，不切换页面');
 }
 async submitted(page,sessionId){
  if(this.sessionId)return;
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
  if(!response.ok)throw blocked('读取本任务引擎状态失败：HTTP '+response.status+'；未切换其他任务的引擎');return response.json();
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
 async wait(page,config,{timeoutMs,capture,log=this.log}){
  const deadline=Date.now()+timeoutMs;let lastLog=0;
  while(Date.now()<deadline){
   const [states,questions,permissions]=await Promise.all([this.get('/session/status'),this.get('/question'),this.get('/permission')]);
   if(!Array.isArray(questions)||!Array.isArray(permissions))throw blocked('引擎待处理交互格式不支持，保留会话');
   const pending=[...questions,...permissions].filter(q=>q.sessionID===this.sessionId);
   if(pending.length){
    await this.withUI(page,'INTERACTING',async()=>{
     // Pending requests are read from this exact session, then the real DOM
     // handler applies all four approval modes, including full access.
     const ownQuestions=questions.filter(q=>q.sessionID===this.sessionId);
     if(ownQuestions.length){
      const expected=ownQuestions.flatMap(q=>q.questions||[]).map(q=>q.question).filter(Boolean);
      if(!expected.length)throw blocked('待回答问题缺少可核对正文');
      await page.waitForFunction(items=>items.some(s=>document.body.innerText.includes(s)),expected,{timeout:10000});
     }
     const handled=await handleConfiguredDialog(page,config,capture,log);
     if(!handled)throw blocked('本会话存在待处理问题或审批，但未识别对应控件，保留现场');
    });
   }else if((states[this.sessionId]?.type||'idle')==='idle'){
    const data=await this.readLog(),last=data.messages.at(-1);
    if(last?.info?.error){await this.call('completed');throw Error('引擎会话错误：'+JSON.stringify(last.info.error));}
    const text=(last?.parts||[]).filter(p=>p.type==='text').map(p=>p.text||'').join('\n');
    if(last?.info?.role==='assistant'&&last.info.time?.completed&&last.info.finish&&last.info.finish!=='tool-calls'&&!(last.parts||[]).some(p=>p.type==='tool')&&text.trim()){await this.call('completed');return data;}
   }
   if(Date.now()-lastLog>30000){log('等待本次模型完成',this.sessionId+'；未占用客户端页面');lastLog=Date.now();}
   await delay(1000);
  }
  throw blocked('等待会话超时；保留运行任务和证据，可强制停止本次会话');
 }
 async close(page){if(this.held&&page&&!this.faulted)await this.release(page,'VERIFYING');}
}
