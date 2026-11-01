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

export const connectClient=(endpoint,options)=>connectDocument(endpoint,options);
export const connectClientMenu=(endpoint,options)=>connectDocument(endpoint,{...options,menu:true});
export const connectClientBrowser=(endpoint,options)=>connectDocument(endpoint,options);
export const connectClientWidgetPin=(endpoint,options)=>connectDocument(endpoint,options);
export const connectAccountExternal=(endpoint,options)=>{
 if(!options?.external?.targetId)throw Error('系统浏览器连接必须提供本轮外链目标');
 return connectDocument(endpoint,options);
};

export function isAccountExternalUrl(value,{origin,route}){
 if(!['/agentCenter/myUsage','/operationsMgr/productAnalysis','/p/portal/manual'].includes(route)||!URL.canParse(value))return false;
 const url=new URL(value),hash=url.hash.slice(1),query=new URLSearchParams(hash.split('?')[1]||'');
 return ['http:','https:'].includes(url.protocol)&&url.origin===origin&&!url.username&&!url.password&&hash.split('?')[0]===route&&![...url.searchParams.keys(),...query.keys()].some(key=>/^(code|code_verifier|access_token|refresh_token|id_token|state|grant_type|token|ticket|nonce)$/i.test(key));
}

async function connectDocument(endpoint,{timeout=7000,menu=false,browserViewId,widgetPin,external}={}){
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
  if(!external&&main.length!==1)throw Error('未找到唯一 MobileWork 主页面（'+main.length+'个），请检查客户端');
  let selected=main[0];
  if(external){
   if(menu||browserViewId||widgetPin)throw Error('外链目标不能与客户端附属页面混用');
   const matches=targets.filter(target=>target.type==='page'&&target.id===external.targetId&&isAccountExternalUrl(target.url,external));
   if(matches.length!==1)throw Error('本轮系统浏览器外链页面归属不匹配');selected=matches[0];
  }
  if(menu||browserViewId||widgetPin){
   if(widgetPin&&(!/^canvas_[A-Za-z0-9_-]+$/.test(widgetPin.canvasId)||!/^widget_[A-Za-z0-9_-]+$/.test(widgetPin.widgetId)))throw Error('桌面组件必须提供本轮看板及组件ID');
   if(browserViewId&&!/^ses_[A-Za-z0-9]+$/.test(browserViewId))throw Error('内嵌浏览器必须归属本轮Session');
   const expected=new URL('overlay.html',main[0].url);expected.hash='';expected.search='';
   const matches=t=>{
    if(t.type!=='page')return false;
    if(widgetPin){if(!URL.canParse(t.url))return false;const candidate=new URL(t.url),owner=new URL(main[0].url);return candidate.protocol===owner.protocol&&candidate.host===owner.host&&candidate.pathname===owner.pathname&&candidate.hash==='#/widget-pin/'+widgetPin.canvasId+'/'+widgetPin.widgetId;}
    if(!browserViewId)return t.url===expected.href;
    if(!t.url.startsWith('file:'))return false;
    const candidate=new URL(t.url);
    return candidate.pathname.endsWith('/resources/app-dist/src/react-app/domains/browser/browser.html')&&candidate.searchParams.get('viewId')===browserViewId;
   };
   let candidates=targets.filter(matches);
   while(!candidates.length&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,100));
    candidates=(await read('/json/list')).filter(matches);
   }
   if(candidates.length!==1)throw Error('未找到唯一 MobileWork '+(widgetPin?'本轮桌面组件':browserViewId?'本Session浏览器':'菜单')+'附属页面，未附加其他窗口');
   selected=candidates[0];
  }
  const socketUrl=localEndpoint(version.webSocketDebuggerUrl,['ws:']);
  if(socketUrl.port!==url.port)throw Error('CDP发现地址端口不一致');
  const remaining=deadline-Date.now();if(remaining<=0)throw Error('CDP发现超时');
  transport=new ClientTransport(socketUrl.href,selected.id,{timeout:remaining});
  browser=await chromium.connectOverCDP(transport,{timeout:remaining});
  if(!menu&&!browserViewId&&!widgetPin&&!external)uniqueClientPage(browser);
  browser.once('disconnected',()=>transport.close());
  return browser;
 }catch(error){
  transport?.close();
  if(browser)await browser.close().catch(()=>{});
  if(controller.signal.aborted)throw Error('MobileWork CDP 连接超时（'+timeout+'ms），请重新检查连接');
  throw error;
 }finally{clearTimeout(timer);controller.abort();}
}
