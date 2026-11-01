import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspectExplorer} from './mobilework-explorer.mjs';
import {ownedKnowledgeCandidate,releaseKnowledgeCreation} from './mobilework-knowledge-resources.mjs';
import {reloadOwnedModule} from './mobilework-module-navigation.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const review=message=>Object.assign(Error(message),{review:true});
const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});
const registrations=items=>items.map(({id,name,storage_dir,wiki_dir,source_dir})=>({id,name,storage_dir,wiki_dir,source_dir})).sort((a,b)=>a.id.localeCompare(b.id));

export async function runKnowledgeListActions(context,{call,created}){
 const {number,page,resources,dir,assert,capture,remaining,checkpointResources}=context;
 const owned=resources.knowledgeCreation,save=(name,data)=>fs.writeFile(path.join(dir,name),JSON.stringify(data,null,2));
 owned.id=created.id;await checkpointResources();
 const initial=await call('/knowledge/list');
 const original=initial.filter(item=>owned.beforeIds.includes(item.id));
 const row=button(page,owned.name).locator('xpath=../..');await row.hover();
 const actions=row.getByRole('button');
 const labels=await actions.evaluateAll(nodes=>nodes.map(node=>({label:node.getAttribute('aria-label'),text:node.textContent})));
 await save('本轮知识库真实行控件.json',labels);
 if(labels.length!==4)throw blocked('知识库行按钮结构与当前安装版不符，未猜测操作');
 if(number===117){
  // Installed dos renders the row trigger, rename, folder, remove in this order.
  await actions.nth(1).click();
  const input=page.getByRole('textbox',{name:'重命名知识库',exact:true});
  await input.fill(owned.renamedName);
  const [response]=await Promise.all([
   page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/knowledge/rename'&&r.request().postDataJSON().id===created.id),
   input.press('Enter')
  ]);
  const body=await response.json();await save('知识库真实重命名.json',{request:response.request().postDataJSON(),response:body});
  assert('重命名请求目标ID及新名称正确',response.ok()&&body.success==='true'&&response.request().postDataJSON().name===owned.renamedName);
  await button(page,owned.renamedName).waitFor();await reloadOwnedModule(page,resources);await button(page,owned.renamedName).waitFor();
  const actual=ownedKnowledgeCandidate(await call('/knowledge/list'),owned);
  assert('重命名同一ID已持久化且原路径保留',actual?.id===created.id&&actual.name===owned.renamedName);
  assert('旧名称行已消失',await button(page,owned.name).count()===0);
  await capture('知识库改名重载后实际列表');remaining.delete('真实行级重命名及同ID持久化');
 }else if(number===118){
  const folder=path.join(created.wiki_dir,'wiki'),baseline=await inspectExplorer(folder);
  await save('知识库目录Explorer基线.json',baseline);
  await actions.nth(2).click();await button(page,'wiki文件夹').click();
  const deadline=Date.now()+15000;let opened;
  do{opened=await inspectExplorer(folder);if(opened.windows.length)break;await page.waitForTimeout(200);}while(Date.now()<deadline);
  await save('知识库目录Explorer实际路径.json',opened);
  const added=opened.windows.filter(item=>!baseline.windows.some(before=>before.hwnd===item.hwnd));
  if(added.length===1){resources.explorerWindow={path:folder,hwnd:added[0].hwnd};await checkpointResources();}
  assert('列表目录入口实际打开本轮Wiki文件夹',opened.windows.length===1&&added.length===1,opened);
  await capture('知识库文件夹实际打开');remaining.delete('真实目录入口及Explorer路径');
 }else{
  const token=randomUUID();owned.dialogToken=token;await checkpointResources();
  await actions.nth(3).click();
  const dialog=page.getByRole('dialog',{name:'您确定移除知识库吗？',exact:true});await dialog.waitFor();
  await dialog.evaluate((node,value)=>node.setAttribute('data-mw-knowledge-owner',value),token);
  assert('移除确认框默认保留本地文件',!await dialog.getByRole('checkbox').isChecked());
  await save('知识库移除确认框.json',{id:created.id,text:await dialog.innerText(),deleteGeneratedFiles:false});
  await capture('知识库移除二次确认');remaining.delete('真实移除确认及保留文件');
  if(number===119){
   owned.removing=true;await checkpointResources();
   const [response]=await Promise.all([
    page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/knowledge/remove'&&r.request().postDataJSON().id===created.id),
    dialog.getByRole('button',{name:'确认',exact:true}).click()
   ]);
   const body=await response.json(),request=response.request().postDataJSON();await save('知识库真实移除请求.json',{request,response:body});
   assert('实际移除本轮注册且未同步删除文件',response.ok()&&body.success==='true'&&String(request.sync_delete_data)==='0');
   await dialog.waitFor({state:'hidden'});await button(page,owned.name).waitFor({state:'hidden'});await reloadOwnedModule(page,resources);
   await page.locator('[data-knowledge-guide="entry"]').waitFor();
   assert('重载后本轮ID及列表行已移除',!(await call('/knowledge/list')).some(item=>item.id===created.id)&&await button(page,owned.name).count()===0);
   assert('移除注册后本轮实际文件保留',(await fs.stat(owned.storageDir)).isDirectory()&&(await fs.stat(created.wiki_dir)).isDirectory());
   await capture('知识库确认移除后列表');remaining.delete('确认移除及重载和目录保留');
  }else{
   const requests=[];const observe=request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/knowledge/remove'&&request.postDataJSON()?.id===created.id)requests.push(request.postDataJSON());};
   page.on('request',observe);
   try{
    await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await reloadOwnedModule(page,resources);await button(page,owned.name).waitFor();
    const actual=ownedKnowledgeCandidate(await call('/knowledge/list'),owned);
    assert('取消没有发送目标移除请求且原ID名称仍持久化',requests.length===0&&actual?.id===created.id&&actual.name===owned.name,{requests:requests.length,id:actual?.id});
   }finally{page.off('request',observe);}
   await capture('知识库取消移除后仍存在');remaining.delete('取消无移除请求及持久化保留');
  }
  delete owned.dialogToken;await checkpointResources();
 }
 const after=await call('/knowledge/list');
 await save('原有知识库保护.json',{before:original,after:after.filter(item=>owned.beforeIds.includes(item.id))});
 assert('本条行操作未改动原有知识库名称及目录登记',JSON.stringify(registrations(original))===JSON.stringify(registrations(after.filter(item=>owned.beforeIds.includes(item.id)))));
 await releaseKnowledgeCreation(page,resources);await checkpointResources();remaining.delete('本轮注册公共收尾及材料保留');
}

export async function runKnowledgeOnboardingObservation(context){
 const {page,resources,checkpointResources,dir,capture,remaining}=context;
 const history=await page.evaluate(async()=>{
  const invoke=window.__MOBILEWORK__.invoke,auth=await invoke('auth:current');
  const {value}=await invoke('store:read',{accountId:auth.account.id,path:'knowledge/onboarding.json',fallback:{}});
  return {completed:value??{}};
 });
 await fs.writeFile(path.join(dir,'知识库引导实际历史.json'),JSON.stringify(history,null,2));
 resources.moduleNavigation={originUrl:page.url(),targetHash:'#/knowledge'};await checkpointResources();
 await button(page,'知识库').click();await button(page,'管理知识库').click();await page.waitForURL(url=>url.hash==='#/knowledge');
 await page.locator('[data-knowledge-guide="entry"]').waitFor();await capture('知识中心引导实际现场');
 await fs.writeFile(path.join(dir,'知识库引导实际界面.json'),JSON.stringify({dialogs:await page.getByRole('dialog').filter({visible:true}).allTextContents(),completed:history.completed},null,2));
 remaining.delete('实际账号引导历史及入口现场');
 throw review('新用户首次进入、跳过/完成及重装后同账号不再显示需要专用首次账号和重装阶段；当前只记录真实历史和现场，未清除用户引导记录，完整生命周期尚未实现');
}
