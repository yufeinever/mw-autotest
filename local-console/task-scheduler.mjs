import {isClientPageUrl} from './client-page.mjs';
// One script runs through completion and handoff before admitting the next.
// Renderer ownership checks still protect interactions, evidence and recovery.
export class TaskScheduler {
 constructor({changed=()=>{}}={}){this.entries=[];this.renderers=new Map();this.locations=new Map();this.changed=changed;this.pumping=false;}
 renderer(port){if(!this.renderers.has(port))this.renderers.set(port,{owner:null,waiting:[],expectedUrl:null,unresolved:new Set()});return this.renderers.get(port);}
 enqueue(job,{cooperative=false,start}){this.locations.set(job.id,job.config.cdpPort);this.entries.push({job,cooperative,start,running:false,preparing:true});this.pump();}
 pump(){
  if(this.pumping)return;this.pumping=true;
  try{for(const entry of this.entries){
   if(entry.running||entry.job.status!=='QUEUED')continue;
   const {job}=entry,port=job.config.cdpPort;
   if(this.renderer(port).unresolved.size||this.renderer(port).connectionError)continue;
   const earlier=this.entries.find(e=>!e.running&&e.job.status==='QUEUED'&&e.job.config.cdpPort===port);
   if(earlier!==entry)continue;
   if(this.entries.some(e=>e.running))continue;
   entry.running=true;job.status='RUNNING';job.phase='PREPARING';job.startedAt=new Date().toISOString();
   Promise.resolve().then(()=>entry.start()).catch(error=>{job.status='FAIL';job.error=error.message;job.endedAt=new Date().toISOString();this.finish(job.id);this.changed(job);});
  }}finally{this.pumping=false;}
 }
 entry(id){const entry=this.entries.find(e=>e.job.id===id);if(!entry?.running)throw Error('任务没有在执行，不能操作客户端');return entry;}
 waitForConnection(job,error){
  const entry=this.entry(job.id),r=this.renderer(job.config.cdpPort);
  r.connectionError=error;entry.running=false;
  job.status='QUEUED';job.phase='WAITING_CONNECTION';job.startedAt=null;
  job.connectionWait={reason:error,at:new Date().toISOString()};
  this.changed(job);this.pump();
 }
 resumeConnection(port){
  delete this.renderer(port).connectionError;
  for(const {job} of this.entries.filter(e=>e.job.config.cdpPort===port&&e.job.status==='QUEUED')){
   delete job.connectionWait;delete job.queueHold;job.phase='QUEUED';this.changed(job);
  }
  this.pump();
 }
 nextStatus(id){
  return {ready:false,reason:'已取消并行执行，请等待当前用例及收尾完成'};
 }
 advance(){throw Error('已取消并行执行，请等待当前用例及收尾完成');}
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
  if(typeof url!=='string'||!isClientPageUrl(url))throw Error('页面地址无效');
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
  // Cancelling all queued work also ends its connection pause. A new batch
  // must perform a fresh probe instead of inheriting an abandoned queue.
  if(!this.entries.some(e=>e.job.config.cdpPort===port))delete r.connectionError;
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
