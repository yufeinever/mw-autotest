import {redactTrace} from './trace.mjs';

const millis=v=>v==null?undefined:typeof v==='number'?v:Date.parse(v);
const tokens=t=>({input:t?.input||0,output:t?.output||0,reasoning:t?.reasoning||0,cacheRead:t?.cache?.read??t?.cacheRead??0,cacheWrite:t?.cache?.write??t?.cacheWrite??0});
// Only project sessions and parts already accepted by the Trace ownership checks.
export function toObservatory(trace,source){
 const logs=new Map(),pending=source?[source]:[];
 while(pending.length){const log=pending.shift();if(logs.has(log.sessionId))continue;logs.set(log.sessionId,log);pending.push(...(log.children||[]));}
 const nodes=new Map();
 for(const session of trace.sessions){
  const events=trace.events.filter(e=>e.sessionId===session.id),log=logs.get(session.id),groups=new Map();
  for(const event of events){if(!groups.has(event.messageId))groups.set(event.messageId,[]);groups.get(event.messageId).push(event);}
  const timeline=[...groups].map(([id,parts],seq)=>{
   const info=log?.messages?.find(m=>m.info?.id===id&&m.info.sessionID===session.id)?.info||{};
   const step=parts.find(e=>e.kind==='step'),time={created:info.time?.created??millis(parts[0].time)};
   if(info.time?.completed!=null)time.completed=info.time.completed;
   const tools=parts.filter(e=>e.kind==='tool').map(e=>({id:e.partId,callID:e.callId,name:e.tool,status:e.status,input:e.input,output:e.output,error:e.error,time:{start:millis(e.time),end:millis(e.endedAt)},childSessionId:e.metadata?.sessionId||null}));
   return {id,seq,type:info.role||parts[0].role||'assistant',time,agent:info.agent,model:{id:info.modelID||parts[0].model,provider:info.providerID},finish:info.finish||step?.status||null,error:info.error||parts.find(e=>e.kind==='error')?.error,tokens:tokens(info.tokens||step?.tokens),text:parts.filter(e=>e.kind==='message').map(e=>e.text).join('\n'),thinking:'',tools,waitTiming:null};
  });
  const totals=tokens();for(const item of timeline.filter(m=>m.type==='assistant'))for(const key of Object.keys(totals))totals[key]+=item.tokens[key];
  nodes.set(session.id,{session:{id:session.id,title:session.title||session.id,parent_id:session.parentId,time_created:millis(session.startedAt),time_updated:millis(session.endedAt),model:typeof session.model==='string'?{id:session.model}:session.model,agent:session.agent,tokens:totals},timeline,childTraces:[],associations:[],warnings:[],summary:{steps:timeline.filter(m=>m.type==='assistant').length,toolCalls:events.filter(e=>e.kind==='tool').length}});
 }
 for(const session of trace.sessions){const node=nodes.get(session.id),parent=nodes.get(session.parentId);if(parent)parent.childTraces.push(node);}
 for(const node of nodes.values())for(const step of node.timeline)for(const tool of step.tools){if(tool.name==='task'&&node.childTraces.some(c=>c.session.id===tool.childSessionId))node.associations.push({callID:tool.callID,childSessionId:tool.childSessionId,status:'resolved'});}
 const root=nodes.get(trace.sessionId);if(!root)throw Error('Trace缺少主会话');
 root.warnings=trace.warnings.map(reason=>({sessionId:trace.sessionId,reason}));
 return redactTrace({ok:true,...root,snapshotRevision:trace.sourceExportedAt||trace.exportedAt,refreshedAt:millis(trace.exportedAt),integration:'mw-autotest-snapshot-v1'});
}
