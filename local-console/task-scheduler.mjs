// Model work may overlap. A renderer turn only covers submission, an interaction,
// or evidence capture; it never covers the model's whole running time.
export class TaskScheduler {
 constructor({changed=()=>{}}={}){this.entries=[];this.renderers=new Map();this.locations=new Map();this.changed=changed;this.pumping=false;}
 renderer(port){if(!this.renderers.has(port))this.renderers.set(port,{owner:null,waiting:[],expectedUrl:null,unresolved:new Set()});return this.renderers.get(port);}
 enqueue(job,{cooperative=false,start}){this.locations.set(job.id,job.config.cdpPort);this.entries.push({job,cooperative,start,running:false,preparing:true});this.pump();}
 pump(){
  if(this.pumping)return;this.pumping=true;
  try{for(const entry of this.entries){
   if(entry.running||entry.job.status!=='QUEUED')continue;
   const {job}=entry,port=job.config.cdpPort,live=this.entries.filter(e=>e.running&&e.job.config.cdpPort===port);
   if(this.renderer(port).unresolved.size)continue;
   const earlier=this.entries.find(e=>!e.running&&e.job.status==='QUEUED'&&e.job.config.cdpPort===port);
   if(earlier!==entry)continue;
   if(live.some(e=>e.preparing||!e.cooperative||e.job.config.executionStrategy!=='parallel'))continue;
   if(live.length&&(!entry.cooperative||job.config.executionStrategy!=='parallel'))continue;
   if(live.length>=job.config.maxParallel||live.some(e=>live.length>=e.job.config.maxParallel))continue;
   entry.running=true;job.status='RUNNING';job.phase='PREPARING';job.startedAt=new Date().toISOString();
   Promise.resolve().then(()=>entry.start()).catch(error=>{job.status='FAIL';job.error=error.message;job.endedAt=new Date().toISOString();this.finish(job.id);this.changed(job);});
  }}finally{this.pumping=false;}
 }
 entry(id){const entry=this.entries.find(e=>e.job.id===id);if(!entry?.running)throw Error('任务没有在执行，不能操作客户端');return entry;}
 nextStatus(id){
  const source=this.entries.find(e=>e.job.id===id),job=source?.job;
  if(!source?.running||job.status!=='RUNNING'||!source.cooperative)return {ready:false,reason:'当前脚本未在执行或未接入会话调度'};
  if(job.manualNext)return {ready:false,reason:'本次运行已经执行下条'};
  const port=job.config.cdpPort,r=this.renderer(port),live=this.entries.filter(e=>e.running&&e.job.config.cdpPort===port);
  if(r.unresolved.size)return {ready:false,reason:'客户端存在未恢复的调度锁'};
  if(r.owner||r.waiting.length)return {ready:false,reason:'客户端正在提交、截图或处理交互，请稍后再试'};
  if(live.some(e=>!e.cooperative||e.preparing||e.job.status!=='RUNNING'||e.job.phase!=='WAITING_MODEL'||!e.job.sessionId||e.job.stopRequested||e.job.submissionPending||e.job.modelCompleted))return {ready:false,reason:'需要当前任务已提交并处于等待模型阶段'};
  if(live.length>=Math.max(2,Math.min(...live.map(e=>e.job.config.maxParallel))))return {ready:false,reason:'已达到同时运行数量上限，请等待一条结束'};
  const next=this.entries.find(e=>!e.running&&e.job.status==='QUEUED'&&e.job.config.cdpPort===port);
  if(next&&!next.cooperative)return {ready:false,reason:'下一条脚本未接入会话调度，不能与当前任务同时运行'};
  return {ready:true,nextId:next?.job.id};
 }
 advance(id,targetId){
  const state=this.nextStatus(id);if(!state.ready)throw Error(state.reason);
  if(!state.nextId||state.nextId!==targetId)throw Error('排队的下一条已变化，请刷新后重试');
  const source=this.entry(id),next=this.entries.find(e=>e.job.id===targetId);
  if(this.entries.filter(e=>e.running&&e.job.config.cdpPort===next.job.config.cdpPort).length>=Math.max(2,next.job.config.maxParallel))throw Error('下一条的同时运行数量已达上限');
  source.job.manualNext={at:new Date().toISOString(),jobId:targetId};next.job.manualPrevious=id;
  // One explicit admission, not a change to the batch strategy. Keep the
  // current runner alive so it still collects its own result and trace.
  next.running=true;next.job.status='RUNNING';next.job.phase='PREPARING';next.job.startedAt=new Date().toISOString();
  this.changed(source.job);this.changed(next.job);
  Promise.resolve().then(()=>next.start()).catch(error=>{next.job.status='FAIL';next.job.error=error.message;next.job.endedAt=new Date().toISOString();this.finish(next.job.id);this.changed(next.job);});
  return next.job;
 }
 reserveRecovery(job){
  this.locations.set(job.id,job.config.cdpPort);
  const r=this.renderer(job.config.cdpPort);
  if(r.owner&&r.owner!==job.id)return false;
  r.owner=job.id;return true;
 }
 releaseRecovery(job){const r=this.renderer(job.config.cdpPort);if(r.owner===job.id)r.owner=null;}
 acquire(id,phase){
  const {job}=this.entry(id),r=this.renderer(job.config.cdpPort);
  if(!['PREPARING','INTERACTING','EVIDENCE'].includes(phase))throw Error('页面操作阶段无效');
  if(r.owner===id)return {granted:true,expectedUrl:r.expectedUrl};
  if(!r.waiting.includes(id))r.waiting.push(id);
  if(r.owner||r.waiting[0]!==id)return {granted:false};
  r.waiting.shift();r.owner=id;job.phase=phase;this.changed(job);
  return {granted:true,expectedUrl:r.expectedUrl};
 }
 release(id,{url,sessionId,phase='WAITING_MODEL'}={}){
  const entry=this.entry(id),{job}=entry,r=this.renderer(job.config.cdpPort);
  if(r.owner!==id)throw Error('本任务没有页面操作权');
  if(typeof url!=='string'||!url.includes('MobileWork/resources/app-dist/index.html'))throw Error('页面地址无效');
  if(!['WAITING_MODEL','VERIFYING','PREPARING'].includes(phase))throw Error('任务阶段无效');
  if(sessionId){
   if(!/^ses_[A-Za-z0-9]+$/.test(sessionId)||!url.endsWith('/session/'+sessionId))throw Error('会话与页面地址不一致');
   if(job.sessionId&&job.sessionId!==sessionId)throw Error('不得更换本任务所属会话');
   job.sessionId=sessionId;job.sessionUrl=url;entry.preparing=false;
  }
  r.expectedUrl=url;r.owner=null;job.phase=phase;this.changed(job);this.pump();
 }
 finish(id,{unresolved=false}={}){
  const entry=this.entries.find(e=>e.job.id===id),port=this.locations.get(id);if(port===undefined)return;
  const r=this.renderer(port);if(unresolved)r.unresolved.add(id);else r.unresolved.delete(id);
  if(r.owner===id)r.owner=null;r.waiting=r.waiting.filter(x=>x!==id);
  this.entries=this.entries.filter(e=>e!==entry);
  // A URL is an ownership check only while this renderer still has managed
  // work. After the final confirmed completion/stop, a new run must inspect
  // the current page rather than inherit the previous run's navigation.
  // Do this before pump(), which may immediately start the next queued job.
  if(!r.unresolved.size&&!this.entries.some(e=>e.running&&e.job.config.cdpPort===port)){
   r.expectedUrl=null;
  }
  this.pump();
 }
}
