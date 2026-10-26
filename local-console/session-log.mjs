import {readEngineConnection} from './engine-client.mjs';
// Production uses Node HTTP; retain the serializable core for historical fixtures.
export async function readSessionLogFromPage(page,request){
 const connection=await readEngineConnection(page);
 return readSessionLog({...(typeof request==='string'?{sessionId:request}:request),connection});
}
export async function readSessionLog(request){
 const sessionId=typeof request==='string'?request:request?.sessionId;
 const includeChildren=typeof request==='object'&&request.includeChildren===true;
 if(!/^ses_[A-Za-z0-9]+$/.test(sessionId))throw Error('会话 ID 无效');
 const info=typeof request==='object'&&request.connection?request.connection:await window.__OPENWORK_ELECTRON__.invokeDesktop('engineInfo');
 if(typeof info?.baseUrl!=='string'||!info.baseUrl.trim())throw Error('客户端引擎尚未就绪：缺少引擎地址；请等待准备完成后再读取会话');
 const base=String(info.baseUrl||'').replace(/\/$/,'');
 const headers={Authorization:'Basic '+btoa(info.opencodeUsername+':'+info.opencodePassword)};
 async function get(route){
  const res=await fetch(base+route,{headers,redirect:'error',signal:AbortSignal.timeout(20000)});
  if(res.status===404)throw Error('当前客户端找不到该会话或消息（HTTP 404），可能已删除或不在当前引擎中；不是执行失败导致禁止下载');
  if(!res.ok)throw Error('读取 session 日志失败：HTTP '+res.status);
  return res.json();
 }
 async function read(id){
  const session=await get('/session/'+id);
  if(session.id!==id)throw Error('返回的会话 ID 不匹配');
  const query=session.directory?'?directory='+encodeURIComponent(session.directory):'';
  const messages=await get('/session/'+id+'/message'+query);
  if(!Array.isArray(messages)||messages.some(m=>m.info?.sessionID!==id))throw Error('会话消息格式或归属不匹配');
  return {sessionId:id,session,messages};
 }
 const root=await read(sessionId),{session,messages}=root,children=[],traceErrors=[];
 if(includeChildren){
  const queue=[root],seen=new Set([sessionId]),deadline=Date.now()+45000;
  for(let index=0;index<queue.length;index++){
   const parent=queue[index],query=parent.session.directory?'?directory='+encodeURIComponent(parent.session.directory):'';
   if(Date.now()>deadline){traceErrors.push('子会话采集达到45秒上限');break;}
   try{
    const list=await get('/session/'+parent.sessionId+'/children'+query);
    if(!Array.isArray(list))throw Error('子会话列表格式异常');
    for(const item of list){
     if(!/^ses_[A-Za-z0-9]+$/.test(item.id)||item.parentID!==parent.sessionId)throw Error('子会话父子归属不匹配');
     if(seen.has(item.id))continue;
     if(seen.size>=64||Date.now()>deadline)throw Error('子会话采集达到数量或时间上限');
     seen.add(item.id);
     try{const child=await read(item.id);if(child.session.parentID!==parent.sessionId)throw Error('子会话回读归属不匹配');children.push(child);queue.push(child);}catch(e){traceErrors.push(item.id+'：'+e.message);}
    }
   }catch(e){traceErrors.push(parent.sessionId+'：'+e.message);}
  }
 }
 const secrets=[info.opencodePassword,headers.Authorization,...(Array.isArray(info.redactionSecrets)?info.redactionSecrets.filter(s=>typeof s==='string'):[])];
 try{const models=await window.__MOBILEWORK__.invoke('models:list');for(const m of models.models||[])if(m.apiKey)secrets.push(m.apiKey);}catch{}
 const clean=value=>{
  if(Array.isArray(value))return value.map(clean);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^(api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token|cookie)$/i.test(k)?'[REDACTED]':clean(v)]));
  if(typeof value!=='string')return value;
  for(const secret of secrets)if(secret&&secret.length>=6)value=value.split(secret).join('[REDACTED]');
  return value.replace(/\b(?:sk-|ghp_|cfat_)[A-Za-z0-9_-]{10,}/g,'[REDACTED]').replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}/gi,'$1 [REDACTED]').replace(/((?:api[_-]?key|password|access[_-]?token)\s*[=:]\s*["']?)[^\s"',;}]+/gi,'$1[REDACTED]');
 };
 return clean({format:'mobilework-session-log',version:1,exportedAt:new Date().toISOString(),sessionId,source:'MobileWork local engine session/message API',redaction:'已隐藏凭证字段、已知客户端凭证及常见令牌；消息和工具调用保留原结构',snapshot:true,note:'导出时刻的会话快照；执行中的会话后续消息不包含在本次文件中',messageCount:messages.length,session,messages,...(includeChildren?{children,traceErrors,childrenCollected:true}:{})});
}
