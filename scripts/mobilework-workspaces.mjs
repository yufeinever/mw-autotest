import {selectNativeFolder} from './mobilework-native-folder.mjs';
import {initializeTestPage} from './mobilework-initialize.mjs';
import {snapshotDraft} from './mobilework-isolation.mjs';
const blocked=message=>Object.assign(Error(message),{blocked:true});
const visible=locator=>locator.filter({visible:true});
const button=(page,name)=>visible(page.getByRole('button',{name,exact:true}));
async function workspaceApi(page){
 const info=await page.evaluate(()=>window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo'));
 const base=String(info.baseUrl).replace(/\/$/,'');
 const headers={Authorization:'Bearer '+(info.ownerToken||info.clientToken),'Content-Type':'application/json'};
 return {base,headers};
}
export async function workspaces(page){
 const api=await workspaceApi(page),response=await fetch(api.base+'/workspaces',{headers:api.headers});
 if(!response.ok)throw Error('读取工作空间列表失败：HTTP '+response.status);
 const data=await response.json();return {api,items:data.items||data.workspaces};
}
export async function workspaceSessions(page,id){
 const api=await workspaceApi(page),response=await fetch(api.base+'/workspace/'+encodeURIComponent(id)+'/sessions?roots=true&limit=1000',{headers:api.headers});
 if(!response.ok)throw Error('读取空间任务失败HTTP '+response.status);
 const data=await response.json();return Array.isArray(data)?data:data.items||data.sessions;
}
// Prepare real, empty task records through the same product route used by the
// client. The server allocates each task directory and persists its mapping.
export async function createWorkspaceSession(page,id,title){
 const api=await workspaceApi(page),response=await fetch(api.base+'/workspace/'+encodeURIComponent(id)+'/opencode/session',{method:'POST',headers:api.headers,body:JSON.stringify({title})});
 if(!response.ok)throw Error('准备空间任务失败：HTTP '+response.status);
 const session=await response.json();
 if(!/^ses_[A-Za-z0-9]+$/.test(session.id))throw Error('产品创建任务未返回有效Session ID');
 return session;
}
async function workspaceTrigger(page,items){
 const candidate=visible(page.locator('button[aria-label="权限"]').locator('xpath=preceding-sibling::button[@aria-haspopup="dialog"]'));
 if(await candidate.count()===1)return candidate;
 throw blocked('未找到当前输入区的工作空间选择器');
}
async function openWorkspacePicker(page){
 const {items}=await workspaces(page),trigger=await workspaceTrigger(page,items);
 await trigger.click();
 const dialog=visible(page.getByRole('dialog'));
 await dialog.waitFor();
 return {dialog,items};
}
export async function chooseWorkspace(page,name){
 const {dialog}=await openWorkspacePicker(page),search=visible(dialog.locator('input[placeholder="搜索工作空间"]'));
 if(await search.count())await search.fill(name);
 const option=button(dialog,name);
 if(await option.count()!==1)throw blocked('工作空间列表中未找到唯一入口：'+name);
 await option.click();
 await button(page.locator('main').last(),name).waitFor();
 return name;
}
export async function createDefaultWorkspace(page,name){
 const {dialog}=await openWorkspacePicker(page);
 await button(dialog,'默认存储空间创建').click();
 const modal=visible(page.getByRole('dialog'));
 const input=visible(modal.locator('input[placeholder="请输入工作空间名称"]'));
 await input.fill(name);await button(modal,'确认').click();
 // The product shows 创建中 until folder creation and workspace setup finish.
 await modal.waitFor({state:'hidden',timeout:90000});
 const deadline=Date.now()+90000;let created;
 while(Date.now()<deadline){
  created=(await workspaces(page)).items.find(item=>item.name===name);
  if(created)break;
  await page.waitForTimeout(200);
 }
 if(!created)throw blocked('默认存储空间创建后尚未出现在工作空间列表');
 await page.waitForURL(url=>url.toString().endsWith('/workspace/'+created.id+'/session'));
 await button(page.locator('main').last(),name).waitFor();
 return created;
}
export async function createLocalWorkspace(page,folder,log,dir,control){
 const picker=await selectNativeFolder(page,{folder,dir,log,control,open:async()=>{
  const header=page.locator('div[class*="workspace-header-title"]').first();
  if(await header.count())await header.hover();
  await button(page,'添加工作空间').click();
  await page.getByText('选择本地文件夹创建',{exact:true}).last().click();
 }});
 const deadline=Date.now()+90000;let created;
 while(Date.now()<deadline){
  const {items}=await workspaces(page);created=items.find(item=>String(item.path||item.directory||'').toLowerCase()===folder.toLowerCase());
  if(created)break;
  await page.waitForTimeout(500);
 }
 if(!created)throw blocked('本地文件夹已选择，但工作空间尚未出现在产品列表');
 await page.waitForURL(url=>url.toString().endsWith('/workspace/'+created.id+'/session'));
 await button(page.locator('main').last(),created.name).waitFor();
 return {...created,nativePicker:picker};
}
export async function deleteWorkspace(page,id){
 const {api}=await workspaces(page),response=await fetch(api.base+'/workspaces/'+encodeURIComponent(id),{method:'DELETE',headers:api.headers});
 if(!response.ok)throw Error('清理本轮工作空间失败：HTTP '+response.status);
}

export const workspaceRow=(page,id)=>page.getByTestId('workspace-section').locator('[id="'+id+'"]');
export const workspaceExpand=row=>row.locator('[data-workspace-row-header] > button[aria-expanded]');
export async function readWorkspaceSidebar(page){
 return page.getByTestId('workspace-section').evaluate(section=>({
  heading:section.querySelector('#workspace-heading')?.textContent,
  sectionExpanded:section.querySelector('[data-testid="workspace-section-header"] button[aria-expanded]:not([aria-haspopup])')?.getAttribute('aria-expanded')==='true',
  rows:[...section.querySelectorAll('[id^="ws_"]')].map(row=>({id:row.id,name:row.querySelector('[data-slot="sidebar-menu-button"] span')?.textContent?.trim(),expanded:row.querySelector('[data-workspace-row-header] > button[aria-expanded]')?.getAttribute('aria-expanded')==='true',tasks:[...row.querySelectorAll('[data-slot="sidebar-menu-sub-item"]')].map(item=>({text:item.textContent.trim(),html:item.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g,'<svg/>')}))}))
 }));
}

// The current client renders default-workspace sessions in Recent Tasks. Read
// the row owner's props only to bind its visible title to the real identities;
// never invoke component callbacks or write renderer state.
export async function waitForRecentWorkspaceSession(page,{workspaceId,sessionId,title}){
 const handle=await page.waitForFunction(expected=>{
  const matches=[...document.querySelectorAll('div.group\\/recent-task')].flatMap(row=>{
   if(!row.getClientRects().length||getComputedStyle(row).visibility==='hidden')return [];
   const host=row[Object.keys(row).find(key=>key.startsWith('__reactFiber$'))];
   const owner=host?.return,props=owner?.memoizedProps;
   if(host?.type!=='div'||host.stateNode!==row||owner?.key!==expected.sessionId||props?.workspaceId!==expected.workspaceId||props.session?.id!==expected.sessionId)return [];
   const visibleTitle=[...row.querySelectorAll('span')].find(span=>span.getClientRects().length&&getComputedStyle(span).visibility!=='hidden'&&span.textContent.trim()===expected.title);
   return [{workspaceId:props.workspaceId,sessionId:props.session.id,apiTitle:expected.title,componentTitle:props.session.title,visibleTitle:visibleTitle?.textContent.trim()||null}];
  });
  return matches.length===1&&matches[0].visibleTitle===expected.title?matches[0]:null;
 },{workspaceId,sessionId,title:title.trim()});
 try{return await handle.jsonValue();}
 finally{await handle.dispose();}
}

export async function prepareWorkspaceResources(page,{target=null,existingTargetId,beforeSessionIds}={}){
 const {items}=await workspaces(page),sidebar=await readWorkspaceSidebar(page);
 const storage=await page.evaluate(()=>Object.fromEntries(['openwork.react.workspaceOrder','openwork.react.activeWorkspace','openwork.react.newTaskDraftWorkspace','openwork.react.newTaskHomepageWorkspace'].map(key=>[key,localStorage.getItem(key)])));
 const currentId=page.url().match(/\/workspace\/([^/]+)\/session(?:\/|$)/)?.[1];
 return {beforeIds:items.map(item=>item.id),previousId:(existingTargetId&&items.some(item=>item.id===currentId)?currentId:storage['openwork.react.activeWorkspace'])||items.find(item=>item.isDefault)?.id,storage,sidebar:sidebar.rows.map(({id,expanded})=>({id,expanded})),sectionExpanded:sidebar.sectionExpanded,target,...(existingTargetId?{existingTargetId}:{}),...(beforeSessionIds?{beforeSessionIds}:{})};
}

// Creation and cleanup can navigate before the worker checkpoints its URL.
// Adopt only the recorded target or a fully restored, empty baseline homepage.
export async function adoptWorkspacePage(page,resources){
 const owned=resources.workspaceResources;
 if(!owned||page.url()===resources.url)return null;
 if(owned.existingTargetId){
  const from=new URL(resources.url),current=new URL(page.url());
  const ids=[owned.previousId,owned.existingTargetId];
  if(from.origin!==current.origin||from.pathname!==current.pathname||from.search!==current.search||!ids.some(id=>from.hash==='#/workspace/'+id+'/session'||from.hash.startsWith('#/workspace/'+id+'/session/ses_'))||!ids.some(id=>current.hash==='#/workspace/'+id+'/session'))return null;
  const draft=await snapshotDraft(page);
  return draft.text||draft.skills.length||draft.selection.length?null:draft;
 }
 if(!owned.target)return null;
 const {items}=await workspaces(page);
 const matches=items.filter(item=>!owned.beforeIds.includes(item.id)&&item.name===owned.target.name&&(!owned.target.path||pathKey(item.path)===pathKey(owned.target.path)));
 const created=matches.length===1&&page.url().endsWith('/workspace/'+matches[0].id+'/session');
 if(!created){
  const from=resources.url.match(/\/workspace\/([^/]+)\/session$/);
  if(!from||owned.beforeIds.includes(from[1])||matches.length||items.length!==owned.beforeIds.length||!items.every(item=>owned.beforeIds.includes(item.id)))return null;
  if(page.url()!==resources.url.replace(/\/workspace\/[^/]+\/session$/,'/workspace/'+owned.previousId+'/session'))return null;
  const restored=await page.evaluate(storage=>Object.entries(storage).every(([key,value])=>localStorage.getItem(key)===value),owned.storage);
  if(!restored)return null;
 }
 const draft=await snapshotDraft(page);
 if(draft.text||draft.skills.length||draft.selection.length)return null;
 return draft;
}
const pathKey=value=>String(value||'').replace(/\\/g,'/').toLowerCase();

export async function releaseWorkspaceResources(page,owned,config){
 const draft=await snapshotDraft(page);
 if(draft.text||draft.skills.length||draft.selection.length)throw blocked('空间收尾遇到未清理输入，保留本轮资源');
 const modal=page.getByRole('dialog').filter({visible:true}).filter({has:page.locator('input[placeholder="请输入工作空间名称"]')});
 if(await modal.count()){
  if(!owned.target||await modal.locator('input').inputValue()!==owned.target.name)throw blocked('空间收尾遇到未知创建弹框');
  await button(modal,'取消').click();
 }
 let {items}=await workspaces(page);
 if(owned.existingTargetId){
  const original=items.find(item=>item.id===owned.previousId);
  if(!original)throw blocked('原工作空间已不在，保留当前空间');
  if(/\/session\/ses_[A-Za-z0-9]+$/.test(page.url())){
   await button(page,'新建任务').click();
   await page.waitForURL(url=>url.toString().endsWith('/workspace/'+owned.existingTargetId+'/session'));
   const current=await snapshotDraft(page);
   if(current.text||current.skills.length||current.selection.length)throw blocked('恢复时新任务页出现未知草稿，保留现场');
   await config.checkpointPage();
  }
  if(!page.url().endsWith('/workspace/'+original.id+'/session')){
   await chooseWorkspace(page,original.name);
   await page.waitForURL(url=>url.toString().endsWith('/workspace/'+original.id+'/session'));
   const current=await snapshotDraft(page);
   if(current.text||current.skills.length||current.selection.length)throw blocked('原工作空间出现未知草稿，保留现场');
   await config.checkpointPage();
  }
 }
 if(owned.target){
  const candidates=items.filter(item=>!owned.beforeIds.includes(item.id)&&(owned.target.path?String(item.path).toLowerCase()===owned.target.path.toLowerCase():item.name===owned.target.name));
  if(candidates.length>1)throw blocked('本轮空间不唯一，未移除注册');
  if(candidates.length){
   const original=items.find(item=>item.id===owned.previousId);
   if(!original)throw blocked('原工作空间已不在，保留本轮空间');
   await initializeTestPage(page,{model:config.model||'自动',stepInterval:config.stepInterval,managedSession:true});
   await chooseWorkspace(page,original.name);
   await page.waitForURL(url=>url.toString().endsWith('/workspace/'+original.id+'/session'));
   await config.checkpointPage();
   await deleteWorkspace(page,candidates[0].id);
   const deadline=Date.now()+15000;
   while((await workspaces(page)).items.some(item=>item.id===candidates[0].id)){
    if(Date.now()>deadline)throw blocked('本轮空间注册尚未移除，保留收尾归属');
    await page.waitForTimeout(200);
   }
  }
 }
 // Restore only the workspace preferences captured before this case. Product
 // startup reads these existing persistence keys; no test state is injected.
 await page.evaluate(storage=>{for(const [key,value] of Object.entries(storage)){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}},owned.storage);
 // The custom shell can render the workspace while navigation lifecycle
 // events are still pending. Wait for the actual restored UI after commit.
 await page.reload({waitUntil:'commit'});await page.getByTestId('workspace-section-header').waitFor({timeout:60000});
 if(owned.existingTargetId){const current=await snapshotDraft(page);if(current.text||current.skills.length||current.selection.length)throw blocked('恢复后出现未知草稿，保留现场');}
 await config.checkpointPage();
 const section=page.getByTestId('workspace-section-header').locator('button[aria-expanded]:not([aria-haspopup])');
 if(await section.getAttribute('aria-expanded')!=='true')await section.click();
 for(const baseline of owned.sidebar){
  const row=workspaceRow(page,baseline.id);await row.waitFor();
  const toggle=workspaceExpand(row);if((await toggle.getAttribute('aria-expanded')==='true')!==baseline.expanded)await toggle.click();
 }
 if(!owned.sectionExpanded)await section.click();
}
