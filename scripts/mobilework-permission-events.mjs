// Read-only, per-session fallback for the client's malformed /permission
// serializer. Never infer requests from text or treat missing events as idle.
export class PermissionEvents {
 constructor({connection,directory,sessionId,fetchImpl=fetch,onEvent=()=>{}}){
  this.onEvent=onEvent;
  this.connection=connection;this.directory=directory;this.sessionId=sessionId;this.fetch=fetchImpl;
  this.sequence=0;this.changes=new Map();this.pending=new Map();this.baselined=false;this.connected=false;
 }
 get healthy(){return this.connected&&Date.now()-this.lastFrame<45000;}
 async start(){
  this.controller=new AbortController();
  let settle;
  const ready=new Promise(resolve=>{settle=resolve;});
  const timer=setTimeout(()=>{this.stop();settle(false);},5000);
  this.pump=(async()=>{
   try{
    const {baseUrl,opencodeUsername,opencodePassword}=this.connection;
    const response=await this.fetch(baseUrl.replace(/\/$/,'')+'/event?directory='+encodeURIComponent(this.directory),{
     headers:{Authorization:'Basic '+btoa(opencodeUsername+':'+opencodePassword),Accept:'text/event-stream'},signal:this.controller.signal,
    });
    if(!response.ok||!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw Error('event stream unavailable');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    try{
     while(!this.controller.signal.aborted){
      const {done,value}=await reader.read();if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      if(buffer.length>4*1024*1024)throw Error('event frame too large');
      let boundary;
      while((boundary=/\r?\n\r?\n/.exec(buffer))){
       const frame=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
       const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
       if(!data)continue;
       const decoded=JSON.parse(data),event=decoded.payload??decoded;
       if(decoded.directory&&decoded.directory!==this.directory)throw Error('event directory mismatch');
       this.accept(event);
       if(this.connected){clearTimeout(timer);settle(true);}
      }
     }
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   }catch{/* Never log event bodies, credentials, file paths or patch contents. */}
   finally{clearTimeout(timer);this.stop();settle(false);}
  })();
  return ready;
 }
 accept(event){
  if(!event||typeof event.type!=='string')throw Error('invalid event envelope');
  this.lastFrame=Date.now();
  if(event.type==='server.connected'){this.connected=true;return;}
  if(event.type==='server.instance.disposed')throw Error('engine instance disposed');
  if(!['permission.asked','permission.replied'].includes(event.type))return;
  const p=event.properties;
  if(!p||typeof p.sessionID!=='string')throw Error('permission event lacks owner');
  if(p.sessionID!==this.sessionId)return;
  this.onEvent(event);
  const id=event.type==='permission.asked'?p.id:p.requestID;
  if(typeof id!=='string'||!/^per_[A-Za-z0-9]+$/.test(id))throw Error('permission event lacks request ID');
  const request=event.type==='permission.asked'?{id,sessionID:p.sessionID,permission:p.permission}:null;
  this.changes.set(id,{sequence:++this.sequence,request});
  if(this.changes.size>1000)throw Error('permission event limit');
  if(request)this.pending.set(id,request);else this.pending.delete(id);
 }
 checkpoint(){return this.healthy?this.sequence:null;}
 seed(requests,since){
  if(since===null||!this.healthy||!Array.isArray(requests))return;
  const own=requests.filter(p=>p.sessionID===this.sessionId);
  if(own.some(p=>typeof p.id!=='string'||!/^per_[A-Za-z0-9]+$/.test(p.id)))return;
  const next=new Map(own.map(p=>[p.id,{id:p.id,sessionID:p.sessionID,permission:p.permission}]));
  // Replay events received during the HTTP snapshot, including tombstones;
  // an older snapshot must never resurrect an already answered request.
  for(const [id,change] of this.changes)if(change.sequence>since){
   if(change.request)next.set(id,change.request);else next.delete(id);
  }
  this.pending=next;this.baselined=true;return true;
 }
 snapshot(){return this.healthy&&this.baselined?[...this.pending.values()]:null;}
 stop(){this.connected=false;this.baselined=false;this.controller?.abort();this.pending.clear();}
}
