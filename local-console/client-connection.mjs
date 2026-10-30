import {chromium} from 'playwright-core';
import bundle from 'playwright-core/lib/utilsBundle';
import {isClientPageUrl,uniqueClientPage} from './client-page.mjs';

// Playwright 1.62 exposes ConnectOverCDPTransport. Keep its pinned WebSocket
// implementation, but expose only the discovered application target to it.
// This is per connection: no proxy listener, target deletion or client patch.
const {ws:WebSocket}=bundle;

function localEndpoint(value,protocols){
 const url=new URL(value);
 if(!protocols.includes(url.protocol)||url.hostname!=='127.0.0.1'||url.username||url.password)throw Error('MobileWork CDP 必须使用本机127.0.0.1地址');
 return url;
}

export class ClientTransport {
 constructor(endpoint,targetId,{timeout=7000}={}){
  this.endpoint=endpoint;this.targetId=targetId;this.timeout=timeout;
  this.pending=new Map();this.allowed=new Set();this.targets=new Set([targetId]);this.excluded=new Set();this.queue=[];this.sequence=0;
 }
 open(){
  if(this.socket||this.closed)return;
  const socket=this.socket=new WebSocket(this.endpoint,{handshakeTimeout:this.timeout,followRedirects:false});
  socket.on('open',()=>{for(const message of this.queue)socket.send(message);this.queue=[];});
  socket.on('message',data=>{
   try{this.receive(JSON.parse(data.toString()));}
   catch{this.close('CDP 消息处理失败，请重新检查客户端连接');}
  });
  socket.on('error',()=>this.close('CDP WebSocket 连接失败'));
  socket.on('close',()=>this.close('CDP 连接已断开'));
 }
 transmit(message){
  if(this.closed)return;
  const value=JSON.stringify(message);
  if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(value);
  else this.queue.push(value);
 }
 send(message){
  if(this.closed)return;
  // Chromium consumes an already usable transport (unlike WebKit it does not
  // invoke open()). Open lazily on its first command, after handlers are set.
  this.open();
  // Discovery/auto-attach must not pause unrelated pages or a never-loaded
  // BrowserWindow host. Child frame attachment under the main page stays intact.
  if(!message.sessionId&&message.method==='Target.setAutoAttach')message={...message,params:{...message.params,waitForDebuggerOnStart:false}};
  if(message.method==='Target.attachToTarget'&&!this.targets.has(message.params.targetId)){
   queueMicrotask(()=>this.onmessage?.({id:message.id,...(message.sessionId?{sessionId:message.sessionId}:{}),error:{code:-32000,message:'连接仅允许操作已确认的 MobileWork 主页面'}}));return;
  }
  const id=++this.sequence;this.pending.set(id,{id:message.id,method:message.method});this.transmit({...message,id});
 }
 receive(message){
  if(this.closed)return;
  if(message.id!==undefined){
   const original=this.pending.get(message.id);this.pending.delete(message.id);
   // Playwright creates a browser-level session before newCDPSession(page),
   // used by screenshots/recording. It is a protocol channel, not a UI target.
   if(original?.method==='Target.attachToBrowserTarget'&&message.result?.sessionId)this.allowed.add(message.result.sessionId);
   if(original!==undefined)this.onmessage?.({...message,id:original.id});
   return;
  }
  if(message.method==='Target.attachedToTarget'){
   const {targetInfo,sessionId}=message.params;
   const main=targetInfo.targetId===this.targetId;
   const child=this.allowed.has(message.sessionId)&&['iframe','worker','service_worker'].includes(targetInfo.type);
   const browser=targetInfo.type==='browser'&&!message.sessionId;
   if(!main&&!child&&!browser){
    this.excluded.add(sessionId);
    // Detach only this transport's session; leave the actual target and any
    // other debugger connections alone. Internal ids never reach Playwright.
    this.transmit({id:++this.sequence,method:'Target.detachFromTarget',params:{sessionId},...(message.sessionId?{sessionId:message.sessionId}:{})});
    return;
   }
   this.allowed.add(sessionId);
   if(main||child)this.targets.add(targetInfo.targetId);
  }
  if(message.method==='Target.detachedFromTarget'){
   const id=message.params.sessionId;
   this.allowed.delete(id);
   if(this.excluded.delete(id))return;
  }
  if(this.excluded.has(message.sessionId))return;
  if(message.method==='Target.targetDestroyed')this.targets.delete(message.params.targetId);
  if(message.method==='Target.targetDestroyed'&&message.params.targetId===this.targetId){this.close('MobileWork 主页面已关闭，请重新连接');return;}
  this.onmessage?.(message);
 }
 close(reason){
  if(this.closed)return;
  this.closed=true;this.queue=[];this.pending.clear();this.allowed.clear();this.targets.clear();this.excluded.clear();
  // terminate closes even a half-open connection; no timer or local listener
  // may remain after timeout, recording stop, browser.close or script exit.
  this.socket?.terminate();this.onclose?.(reason);
 }
}

export async function connectClient(endpoint,{timeout=7000}={}){
 const url=localEndpoint(endpoint,['http:']);
 if(url.pathname!=='/'||url.search||url.hash)throw Error('MobileWork CDP 地址必须为本机端口根地址');
 if(!Number.isFinite(timeout)||timeout<=0)throw Error('CDP 连接超时必须大于0');
 const deadline=Date.now()+timeout;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 let transport,browser;
 try{
  const read=async path=>{
   const response=await fetch(new URL(path,url),{signal:controller.signal,redirect:'error'});
   if(!response.ok)throw Error('CDP发现接口不可用：HTTP '+response.status);
   return response.json();
  };
  const [targets,version]=await Promise.all([read('/json/list'),read('/json/version')]);
  if(!Array.isArray(targets))throw Error('CDP页面列表格式异常');
  const main=targets.filter(t=>t.type==='page'&&isClientPageUrl(t.url));
  if(main.length!==1)throw Error('未找到唯一 MobileWork 主页面（'+main.length+'个），请检查客户端');
  const socketUrl=localEndpoint(version.webSocketDebuggerUrl,['ws:']);
  if(socketUrl.port!==url.port)throw Error('CDP发现地址端口不一致');
  const remaining=deadline-Date.now();if(remaining<=0)throw Error('CDP发现超时');
  transport=new ClientTransport(socketUrl.href,main[0].id,{timeout:remaining});
  browser=await chromium.connectOverCDP(transport,{timeout:remaining});
  uniqueClientPage(browser);
  browser.once('disconnected',()=>transport.close());
  return browser;
 }catch(error){
  transport?.close();
  if(browser)await browser.close().catch(()=>{});
  if(controller.signal.aborted)throw Error('MobileWork CDP 连接超时（'+timeout+'ms），请重新检查连接');
  throw error;
 }finally{clearTimeout(timer);controller.abort();}
}
