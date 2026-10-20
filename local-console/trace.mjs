export const traceRuleVersion='skills-invocation-v1';
export function redactTrace(value){
 if(Array.isArray(value))return value.map(redactTrace);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|cookie)$/i.test(key)?'[REDACTED]':redactTrace(item)]));
 if(typeof value!=='string')return value;
 return value.replace(/\b(?:sk-|ghp_|cfat_)[A-Za-z0-9_-]{10,}/g,'[REDACTED]').replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}/gi,'$1 [REDACTED]').replace(/((?:api[_-]?key|password|access[_-]?token)\s*[=:]\s*["']?)[^\s"',;}]+/gi,'$1[REDACTED]');
}
const stamp=value=>{const date=new Date(value);return value&&Number.isFinite(date.getTime())?date.toISOString():null;};
function loadedSkill(part){
 const state=part.state||{},name=state.input?.name;
 if(part.tool!=='skill'||typeof name!=='string')return null;
 const contentName=String(state.output||'').match(/^<skill_content\s+name=["']([^"']+)["']>/)?.[1];
 return {id:name,success:state.status==='completed'&&!state.error&&contentName===name&&state.metadata?.name===name,
  reason:state.status!=='completed'?'调用状态为 '+(state.status||'未知'):state.error?'加载返回错误':contentName!==name||state.metadata?.name!==name?'加载结果身份与请求不一致':'精确 ID、成功状态、加载内容和元数据一致'};
}
export function buildTrace(source,{expectedSkills=[],caseId=null,origin='saved-session',collectionError=null}={}){
 const data=redactTrace(source),rootId=data?.sessionId,warnings=[...(data?.traceErrors||[])];
 if(collectionError)warnings.push(collectionError);
 if(!/^ses_[A-Za-z0-9]+$/.test(rootId||'')||data?.session?.id!==rootId||!Array.isArray(data.messages))throw Error('Trace 缺少有效的主会话快照');
 const logs=[data],pending=[...(data.children||[])],ids=new Set([rootId]);
 while(pending.length){
  const before=pending.length;
  for(let i=pending.length-1;i>=0;i--){const child=pending[i];if(!ids.has(child.session?.parentID))continue;
   pending.splice(i,1);if(ids.has(child.sessionId)){warnings.push('重复子会话 '+child.sessionId);continue;}
   if(!/^ses_[A-Za-z0-9]+$/.test(child.sessionId||'')||child.session?.id!==child.sessionId||!Array.isArray(child.messages)){warnings.push('子会话格式异常');continue;}
   ids.add(child.sessionId);logs.push(child);
  }
  if(before===pending.length){warnings.push('已排除无法证明父子关系的子会话');break;}
 }
 const events=[],sessions=[];
 for(const log of logs){
  const info=log.session;
  sessions.push({id:info.id,parentId:info.parentID||null,title:info.title,agent:info.agent,model:info.model,directory:info.directory,tokens:info.tokens,startedAt:stamp(info.time?.created),endedAt:stamp(info.time?.updated)});
  for(const message of log.messages){
   if(message.info?.sessionID!==log.sessionId){warnings.push('已排除归属不符的消息');continue;}
   const meta=message.info;
   if(meta.error)events.push({kind:'error',sessionId:log.sessionId,messageId:meta.id,time:stamp(meta.time?.created),status:'error',error:meta.error});
   for(const part of message.parts||[]){
    if(part.sessionID&&part.sessionID!==log.sessionId||part.messageID&&part.messageID!==meta.id){warnings.push('已排除归属不符的消息分段');continue;}
    const common={sessionId:log.sessionId,messageId:meta.id,partId:part.id,role:meta.role,agent:meta.agent,model:meta.modelID||meta.model?.modelID,time:stamp(meta.time?.created)};
    if(part.type==='tool'&&meta.role==='assistant'){
     const state=part.state||{},start=stamp(state.time?.start),end=stamp(state.time?.end);
     events.push({...common,kind:'tool',tool:part.tool,callId:part.callID,status:state.status||'unknown',time:start||common.time,endedAt:end,durationMs:start&&end?Date.parse(end)-Date.parse(start):null,title:state.title,input:state.input,output:state.output,error:state.error,metadata:state.metadata,skill:loadedSkill(part)});
    }else if(part.type==='text')events.push({...common,kind:'message',text:part.text||'',status:meta.error?'error':meta.time?.completed?'completed':meta.role==='user'?'sent':'pending'});
    else if(part.type==='step-finish')events.push({...common,kind:'step',status:part.reason,tokens:part.tokens,cost:part.cost});
   }
  }
 }
 events.sort((a,b)=>(Date.parse(a.time)||0)-(Date.parse(b.time)||0));
 events.forEach((event,index)=>event.index=index+1);
 const expected=[...new Set(expectedSkills)],calls=events.filter(e=>e.skill);
 const checks=expected.map(id=>{
  const observed=calls.filter(e=>e.skill.id===id),success=observed.filter(e=>e.skill.success),bad=observed.filter(e=>!e.skill.success);
  return {name:'Skill 实际调用：'+id,category:'skill-invocation',ruleVersion:traceRuleVersion,pass:success.length>0&&bad.length===0,
   actual:observed.length?observed.map(e=>({sessionId:e.sessionId,messageId:e.messageId,callId:e.callId,status:e.status,proof:e.skill.reason})): '未找到该 Skill 的真实工具调用；提示词、文件路径或模型自述不算调用证据'};
 });
 return {format:'mobilework-trace',version:1,ruleVersion:traceRuleVersion,caseId,sessionId:rootId,exportedAt:new Date().toISOString(),sourceExportedAt:data.exportedAt,origin,snapshot:true,
  expectedSkills:expected,checks,sessions,events,warnings:[...new Set(warnings)],childrenCollected:data.childrenCollected===true,
  summary:{sessions:sessions.length,tools:events.filter(e=>e.kind==='tool').length,toolErrors:events.filter(e=>e.kind==='tool'&&e.status==='error').length,skills:[...new Set(calls.map(e=>e.skill.id))],passed:checks.filter(c=>c.pass).length,total:checks.length}};
}

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json=value=>esc(typeof value==='string'?value:JSON.stringify(value,null,2));
const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录';
export function renderTrace(job,trace,error){
 const download='/traces/'+encodeURIComponent(job.id)+'/download';
 const checks=trace?.checks||[];
 const rows=(trace?.events||[]).map(e=>`<tr><td>${e.index}</td><td>${esc(time(e.time))}<small>${e.durationMs==null?'':esc(e.durationMs)+' ms'}</small></td><td>${esc(e.kind==='tool'?e.tool:e.kind==='message'?e.role==='user'?'用户消息':'助手消息':e.kind==='error'?'会话错误':'步骤结束')}<small>${esc(e.sessionId)}</small></td><td class="${e.status==='error'||e.skill&&!e.skill.success?'result-fail':e.status==='completed'?'result-pass':''}">${esc(e.status)}${e.skill?'<small>'+esc(e.skill.id)+'</small>':''}</td><td><details><summary>${esc(e.title||e.text?.slice(0,90)||e.error&&'错误详情'||'调用详情')}</summary>${e.callId?'<p>Call ID：'+esc(e.callId)+'</p>':''}${e.skill?'<p>'+esc(e.skill.reason)+'</p>':''}${e.input!==undefined?'<h3>输入</h3><pre>'+json(e.input)+'</pre>':''}${e.output!==undefined?'<h3>输出</h3><pre>'+json(e.output)+'</pre>':''}${e.text!==undefined?'<pre>'+esc(e.text)+'</pre>':''}${e.error?'<pre class="result-fail">'+json(e.error)+'</pre>':''}${e.tokens?'<p>Tokens：'+json(e.tokens)+'</p>':''}</details></td></tr>`).join('');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trace 记录 · ${esc(job.name)}</title><link rel="stylesheet" href="/style.css"></head><body><main class="report trace"><header><div><small>MOBILEWORK · TRACE</small><h1>Trace 记录</h1><p>${esc(job.name)}</p></div><a href="/reports/${encodeURIComponent(job.id)}">查看报告</a></header><section><h2>本次会话调用过程</h2>${error?'<p class="result-fail">'+esc(error)+'</p>':''}${trace?`<p>主会话：${esc(trace.sessionId)} · ${trace.summary.sessions} 个会话 · ${trace.summary.tools} 次工具调用 · ${trace.summary.toolErrors} 次工具错误</p><p>快照时间：${esc(time(trace.sourceExportedAt||trace.exportedAt))}　<a download href="${download}">下载 Trace JSON</a></p><p class="hint">${trace.origin==='run-snapshot'?'本次执行留存的 Trace':'根据会话日志另行核验；不改写原运行结论'}。执行中或已停止的会话只展示快照中已有记录。</p><h3>Skill 调用断言</h3>${checks.length?checks.map(c=>`<p class="${c.pass?'result-pass':'result-fail'}">${c.pass?'通过':'失败'}：${esc(c.name)}</p><details><summary>核验依据</summary><pre>${json(c.actual)}</pre></details>`).join(''):'<p>此用例未配置预期 Skill，不计入 Skill 调用通过率。</p>'}<p>预期：${esc(trace.expectedSkills.join('、')||'无')}　实际调用：${esc(trace.summary.skills.join('、')||'未发现')}</p>${trace.warnings.map(w=>'<p class="result-fail">采集说明：'+esc(w)+'</p>').join('')}`:'<p>尚无 Trace 数据。未取得会话 ID 时无法生成调用记录。</p>'}</section><section><h2>调用时间线</h2><div class="table"><table><thead><tr><th>序号</th><th>时间 / 耗时</th><th>事件 / 会话</th><th>状态</th><th>内容与输入输出</th></tr></thead><tbody>${rows||'<tr><td colspan="5">暂无可展示记录</td></tr>'}</tbody></table></div></section></main></body></html>`;
}
