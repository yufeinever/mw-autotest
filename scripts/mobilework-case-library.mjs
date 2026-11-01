import {unzipSync,strFromU8} from 'fflate';
import {randomUUID,createHash} from 'node:crypto';
import {snapshotDraft} from './mobilework-isolation.mjs';
import {normalizeComposerText} from './mobilework-composer.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
export const caseDialog=(page,title)=>page.getByRole('dialog',{name:title,exact:true});
export const caseCards=page=>page.locator('.mw-case-card');
export const caseTitles=page=>caseCards(page).locator('img').evaluateAll(nodes=>nodes.map(n=>n.alt));
export const normalizeCaseText=value=>value.normalize('NFKC').replace(/[\s*`_]/g,'');
export const plainCaseText=value=>normalizeCaseText(value.replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/^\s*(?:#{1,6}\s+|[-+>]\s+|\d+[.)]\s+)/gm,'').replace(/^[\s|:-]+$/gm,'').replace(/\|/g,''));

async function assetBytes(page,url){
 const result=await page.evaluate(async url=>{
  const result=await window.__MOBILEWORK__.invoke('assets:fetch',{path:url,method:'GET'});
  if(result.ok===false){
   const networkFailure=typeof result.error==='object'&&/fetch failed/.test(result.error.diagnosticMessage||'');
   return {error:'案例资产请求未取得HTTP响应：'+(result.error?.code||'客户端请求失败')+(networkFailure?'，fetch failed':''),blocked:networkFailure};
  }
  if(result.status!==200)throw Error('案例资产读取失败HTTP '+result.status);
  return {bytes:result.bodyBytes?Array.from(new Uint8Array(result.bodyBytes)):Array.from(atob(result.bodyBase64),c=>c.charCodeAt(0))};
 },url);
 // Playwright serializes thrown errors without custom properties. Classify
 // the bridge result here so the runner receives the actual blocked flag.
 if(result.error)throw Object.assign(Error(result.error),{blocked:result.blocked});
 return new Uint8Array(result.bytes);
}

export async function readCaseAssets(page){
 const records=[];let total;
 for(let pageNo=1;total===undefined||records.length<total;pageNo++){
  const query=new URLSearchParams({assetType:'case',terminalType:'MobileWork',pageNo:String(pageNo),pageSize:'50',orderKey:'featuredDesc'});
  const response=JSON.parse(new TextDecoder().decode(await assetBytes(page,'/asset/api/v1/platform/assets?'+query)));
  if(response.code!==200)throw Error('案例列表接口业务失败：'+response.code);
  total=response.data.total;const batch=response.data.records;
  if(!batch.length&&records.length<total)throw blocked('案例列表分页提前为空，不能将首屏当全量');
  records.push(...batch);
 }
 return records.map(item=>({assetId:item.assetId,id:item.replayCaseId||item.assetId,title:item.assetName,category:item.category||'其他',description:item.description||'',tags:item.tags||[],status:item.assetStatus||'',order:item.order}));
}
export const visibleCaseAssets=items=>items.filter(item=>!['off_shelf','offshelf'].includes(item.status.trim().toLowerCase().replace(/-/g,'_')));
export const caseListSignature=items=>JSON.stringify([...items].sort((a,b)=>a.assetId.localeCompare(b.assetId)));

// Scroll the shipped list's own viewport until the expected full collection is
// rendered. Matching titles are a multiset, allowing distinct assets same name.
export async function waitCaseCollection(page,expected){
 const target=expected.map(item=>item.title).sort(),viewport=page.locator('.mw-module-px').filter({visible:true});
 const deadline=Date.now()+60000;let actual=[];
 while(Date.now()<deadline){
  actual=await caseTitles(page);
  if(JSON.stringify([...actual].sort())===JSON.stringify(target)&&!await page.getByText('加载更多…',{exact:true}).isVisible())return actual;
  await viewport.evaluate(node=>{node.scrollTop=node.scrollHeight;});
  await page.waitForTimeout(200);
 }
 throw blocked('案例列表未达到当前完整资产集合：期望'+target.length+'，实际'+actual.length);
}

export async function readCaseDetail(page,id){
 const response=JSON.parse(new TextDecoder().decode(await assetBytes(page,'/asset/api/v1/platform/assets/'+encodeURIComponent(id)+'/detail')));
 if(response.code!==200)throw Error('案例详情接口业务失败：'+response.code);
 return response.data;
}

export async function readCaseDocument(page,url){
 const bytes=url.startsWith('/asset/')?await assetBytes(page,url):new Uint8Array(await page.evaluate(async url=>{
  const response=await fetch(url);if(!response.ok)throw Error('本地案例文件读取失败HTTP '+response.status);return Array.from(new Uint8Array(await response.arrayBuffer()));
 },url));
 const entries=unzipSync(bytes),xml=strFromU8(entries['word/document.xml']);
 const decode=text=>text.replace(/&#x([a-f0-9]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi,(_,hex,num,name)=>hex?String.fromCodePoint(parseInt(hex,16)):num?String.fromCodePoint(Number(num)):{amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name]);
 const paragraphs=[...xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map(match=>[...match[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m=>decode(m[1])).join('')).filter(p=>p.trim());
 const substantive=paragraphs.filter(p=>normalizeCaseText(p).length>=18);
 if(substantive.length<3)throw blocked('案例Word实际文件缺少足够正文，未将空预览当通过');
 return {bytes,paragraphs,facts:[substantive[0],substantive[Math.floor(substantive.length/2)],substantive.at(-1)]};
}

export async function closeOwnedCaseReplay(page,resources){
 const owned=resources.caseReplay;if(!owned)return;
 if(new URL(page.url()).hash!=='#/explore')throw blocked('案例回放页面已被切换，保留现场');
 const dialog=caseDialog(page,owned.title);
 if(owned.opening)await dialog.waitFor({timeout:90000});
 if(await dialog.count()){
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();await dialog.waitFor({state:'hidden'});
 }
 if(owned.observation)await page.evaluate(key=>{delete window[key];},owned.observation);
 delete resources.caseReplay;
}

export async function openOwnedCase(context,target){
 const {page,resources,checkpointResources}=context;
 if(await page.getByRole('dialog').count())throw blocked('存在未知弹窗，未登记为本轮案例');
 resources.caseReplay={title:target.title,assetId:target.assetId,opening:true};await checkpointResources();
 await caseCards(page).filter({has:page.getByText(target.title,{exact:true})}).click();
 const dialog=caseDialog(page,target.title);await dialog.waitFor({timeout:90000});
 await dialog.getByRole('button',{name:'做同款',exact:true}).waitFor();
 await page.waitForFunction(title=>[...document.querySelectorAll('[role="dialog"]')].find(n=>n.getAttribute('aria-label')===title)?.querySelector('header button')&&!([...document.querySelectorAll('[role="dialog"] button')].find(n=>n.textContent==='做同款')?.disabled),target.title,{timeout:90000});
 resources.caseReplay.opening=false;await checkpointResources();return dialog;
}

export async function readCasePackage(page,assetId){
 const pack=await page.evaluate(assetId=>window.__MOBILEWORK__.invoke('assets:fetchCasePackage',{assetId}),assetId);
 if(pack.ok!==true||pack.caseJson?.version!==1||!pack.caseJson.turns?.length)throw blocked('未取得有效真实回放包');
 pack.caseJson.turns=pack.caseJson.turns.map(turn=>({...turn,subagents:(turn.subagents||[]).map(child=>{
  if(!child.file)return child;
  const extra=pack.subFiles[child.file];if(!extra)throw blocked('回放包缺少子任务文件：'+child.file);
  return {...child,...(extra.tools!==undefined?{tools:extra.tools}:{}),...(extra.result!==undefined?{result:extra.result}:{})};
 })}));return pack;
}

// Observe the product's real replay controller promise. A final heading can
// precede the last tool and idle event. Never synthesize a completion event.
export async function observeCaseReplay(dialog,{timeoutMs,onSample=async()=>{},onObserver=async()=>{}}){
 const key='__mwAutotestReplay_'+randomUUID();
 await onObserver(key);
 const start=await dialog.evaluate((node,key)=>{
  let fiber=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))];
  while(fiber&&fiber.type?.name!=='ybr')fiber=fiber.return;
  let hook=fiber?.memoizedState,ref;
  while(hook){if(hook.memoizedState?.current?.done instanceof Promise&&typeof hook.memoizedState.current.stop==='function'){ref=hook.memoizedState;break;}hook=hook.next;}
  if(!ref)throw Error('当前版本未暴露可识别的真实回放完成句柄，不能仅凭末段文字判断结束');
  const runtime=ref.current,observation={done:false,error:null,startedAt:Date.now(),ref,runtime};
  window[key]=observation;
  runtime.done.then(()=>{observation.done=true;observation.endedAt=Date.now();},error=>{observation.error=String(error);});
  return {startedAt:observation.startedAt};
 },key);
 const page=dialog.page(),deadline=Date.now()+timeoutMs,samples=[];let previous;
 try{
  while(Date.now()<deadline){
   const sample=await dialog.evaluate((node,key)=>{
    const o=window[key];if(!o)throw Error('本轮回放观察句柄已消失');
    if(o.ref.current&&o.ref.current!==o.runtime)throw Error('回放被重新启动，原观察不能冒充本轮完成');
    return {at:Date.now(),done:o.done,error:o.error,endedAt:o.endedAt,messages:[...node.querySelectorAll('[data-message-id]')].map(n=>({id:n.dataset.messageId,text:n.innerText}))};
   },key);
   if(sample.error)throw Error('案例回放失败：'+sample.error);
   const signature=JSON.stringify(sample.messages);if(signature!==previous||sample.done){samples.push(sample);await onSample(sample);previous=signature;}
   if(sample.done){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));return {...start,endedAt:sample.endedAt,samples};}
   await page.waitForTimeout(200);
  }
  throw blocked('案例真实回放未在用例等待预算内结束，保留过程采样');
 }finally{await page.evaluate(key=>{delete window[key];},key);}
}

export async function adoptCaseTaskDraft(page,resources,{finish=true}={}){
 const task=resources.caseTask;if(!task)return null;
 if(new URL(page.url()).hash==='#/explore'){
  if(!resources.caseReplay)throw blocked('做同款交接缺少本轮案例归属');
  delete resources.caseTask;return null;
 }
 const target=new URL(task.originUrl);target.hash='/workspace/'+task.workspaceId+'/session';
 if(page.url()!==target.href)throw blocked('做同款未交接到本轮空间的新任务页，保留现场');
 const allowed=[task.prompt,...(task.editedPrompt?[task.editedPrompt]:[])].map(normalizeComposerText);
 await page.waitForFunction(allowed=>{
  const editors=[...document.querySelectorAll('[contenteditable="true"]')].filter(n=>n.getBoundingClientRect().height);
  return editors.length===1&&allowed.includes(editors[0].innerText.replace(/\r\n/g,'\n').replace(/\n{2,}/g,'\n').trim());
 },allowed,{timeout:30000});
 const draft=await snapshotDraft(page);
 if(!allowed.includes(normalizeComposerText(draft.text))||draft.skills.length||draft.selection.length)throw blocked('做同款实际预填/选择与登记内容不一致，未清理未知草稿');
 delete resources.caseReplay;delete resources.moduleNavigation;
 resources.url=draft.url;if(finish)delete resources.caseTask;return draft;
}

export async function readCaseFavorites(page){
 return page.evaluate(async()=>{
  const invoke=window.__MOBILEWORK__.invoke,auth=await invoke('auth:current');
  const {value}=await invoke('store:read',{accountId:auth.account.id,path:'explore/registry.json',fallback:{}});
  return {accountId:auth.account.id,value};
 });
}
export const favoriteHashes=value=>Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,createHash('sha256').update(JSON.stringify(item)).digest('hex')]));

// Only new keys with the registered official identity belong to this run.
// Preserve all other keys as currently read; do not restore a stale whole file.
export async function releaseCaseFavorites(page,owned){
 const current=await readCaseFavorites(page);if(current.accountId!==owned.accountId)throw blocked('收藏账号已改变，未清理');
 for(const item of owned.targets){
  const actual=current.value[item.id];if(!actual)continue;
  if(actual.title!==item.title||actual.category!==item.category||Object.keys(actual).some(k=>!['favorite','title','category','image'].includes(k)))throw blocked('本轮收藏内容已改变，保留现场：'+item.title);
  delete current.value[item.id];
 }
 await page.evaluate(async({accountId,value})=>window.__MOBILEWORK__.invoke('store:write',{accountId,path:'explore/registry.json',value}),current);
 const after=await readCaseFavorites(page);
 if(JSON.stringify(favoriteHashes(after.value))!==JSON.stringify(favoriteHashes(current.value)))throw blocked('本轮收藏清理回读不一致');
}
