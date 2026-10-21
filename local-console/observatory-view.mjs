import template from './observatory-template.mjs';
import {redactTrace} from './trace.mjs';

export function observatoryDocument(data){
 const payload=JSON.stringify(redactTrace(data)).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 const boot=`<script>
 const snapshot=${payload};
 const snapshots=new Map();(function visit(node){snapshots.set(node.session.id,node);for(const child of node.childTraces||[])visit(child);})(snapshot);
 window.fetch=async input=>{const url=new URL(input,'http://snapshot.local');let result;
 if(url.pathname==='/api/sessions')result={ok:true,version:'v0.0.34 · 集成快照',sessions:[{...snapshot.session,parentId:null,model:snapshot.session.model,updatedAt:snapshot.session.time_updated}],snapshotRevision:snapshot.snapshotRevision,refreshedAt:snapshot.refreshedAt};
 else if(url.pathname==='/api/trace'){const item=snapshots.get(url.searchParams.get('sessionId'));result=item?{ok:true,...item}:{ok:false,error:'快照中没有该会话'};}
 else result={ok:false,error:'快照模式不提供此接口'};
 return new Response(JSON.stringify(result),{status:result.ok?200:404,headers:{'Content-Type':'application/json'}});};
 window.EventSource=class{close(){}};
 </script>`;
 const init=`<script>
 document.querySelector('[data-view="resources"]').hidden=true;
 document.querySelector('.sub').textContent='本次运行的会话证据快照 · 历史缺失的流式耗时及装载快照不补造 · 刷新外层页面重新读取';
 exportNativeSession=async id=>download(JSON.stringify(snapshots.get(id),null,2),'application/json',id+'-observatory.json');
 // Snapshot imports contain no live stream sampling; never infer TTFT from gaps.
 ineffectiveTiming=()=>({state:'unavailable',ttftState:'unavailable',stallState:'unavailable',generationState:'unavailable',milliseconds:null,ttftMilliseconds:null,stallMilliseconds:null,generationMilliseconds:null,reasoningWaitMilliseconds:null,toolInputWaitMilliseconds:null,ttftLabel:'未采集',stallLabel:'未采集',generationLabel:'未采集',label:'未采集'});
 refresh().then(()=>loadTrace(snapshot.session.id)).catch(e=>content.textContent=e.message);
 </script>`;
 return template.replace('<script>',boot+'<script>').replaceAll('导出原生会话','导出会话快照').replace(/setInterval\(.*?\},15000\);/g,'').replace(/setInterval\(.*?\},250\);/g,'')+init;
}
