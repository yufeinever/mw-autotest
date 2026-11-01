import fs from 'node:fs/promises';
import path from 'node:path';
import {
 workspaces,workspaceSessions,chooseWorkspace,createDefaultWorkspace,createLocalWorkspace,workspaceRow,workspaceExpand,
 readWorkspaceSidebar,prepareWorkspaceResources,
} from './mobilework-workspaces.mjs';

const samePath=(left,right)=>path.resolve(left).toLowerCase()===path.resolve(right).toLowerCase();
const inside=(parent,child)=>{
 const relative=path.relative(parent,child);
 return Boolean(relative)&&!relative.startsWith('..')&&!path.isAbsolute(relative);
};

export async function runHomeWorkspaceSteps(context){
 const {number,page,dir,control,resources,remaining,assert,capture,log,send,getSessionId,checkpointResources,checkpointPage}=context;
 if(number===17||number===20){
  const spaces=(await workspaces(page)).items;
  const selected=number===17?spaces.find(item=>item.isDefault):spaces.find(item=>!item.isDefault);
  if(!selected)throw Object.assign(Error(number===17?'未找到默认工作空间':'没有可引用的已有工作空间'),{blocked:true});
  const beforeSessionIds=number===17?(await workspaceSessions(page,selected.id)).map(session=>session.id):undefined;
  resources.workspaceResources=await prepareWorkspaceResources(page,{existingTargetId:selected.id,beforeSessionIds});await checkpointResources();
  await chooseWorkspace(page,selected.name);await checkpointPage();
  const selectedButton=page.locator('main').last().getByRole('button',{name:selected.name,exact:true}).filter({visible:true});
  assert('输入区选中目标工作空间',await selectedButton.count()===1,{id:selected.id,name:selected.name});
  if(number===20){
   const section=page.getByTestId('workspace-section-header').locator('button[aria-expanded]:not([aria-haspopup])');
   if(await section.getAttribute('aria-expanded')!=='true')await section.click();
   const sidebar=await readWorkspaceSidebar(page);
   assert('已有空间在侧栏展示且输入区可引用',sidebar.rows.some(row=>row.id===selected.id&&row.name===selected.name));
   await capture('已有空间已引用');remaining.delete('已有工作空间列表与选择');remaining.delete('输入区与侧栏展示引用空间');return;
  }
  remaining.delete('选择默认工作空间');
  await page.getByRole('button',{name:'新建任务',exact:true}).filter({visible:true}).click();
  await page.waitForURL(url=>url.toString().endsWith('/workspace/'+selected.id+'/session'));await checkpointPage();
  assert('新建任务仍选择默认空间',await selectedButton.count()===1);
  remaining.delete('侧栏新建任务');
  await send('你是谁？（测试标识：'+path.basename(dir)+'）');
  const id=getSessionId(),relative=path.relative(selected.path,control.directory);
  assert('真实Session目录属于默认空间',!relative.startsWith('..')&&!path.isAbsolute(relative),{id,directory:control.directory});
  remaining.delete('发送并建立默认空间Session');
  await control.withUI(page,'VERIFYING',async()=>{
   const sessions=await workspaceSessions(page,selected.id),session=sessions.find(item=>item.id===id);
   assert('产品登记了本轮Session标题',Boolean(session?.title?.trim()),{id,title:session?.title});
   const section=page.getByTestId('workspace-section-header').locator('button[aria-expanded]:not([aria-haspopup])');
   if(await section.getAttribute('aria-expanded')!=='true')await section.click();
   const row=workspaceRow(page,selected.id);
   if(await row.count()&&await workspaceExpand(row).getAttribute('aria-expanded')!=='true')await workspaceExpand(row).click();
   const displayed=await row.getByText(session.title,{exact:true}).filter({visible:true}).count();
   const recent=page.locator('div.group\\/recent-task').filter({visible:true}).filter({has:page.getByText(session.title,{exact:true})});
   await capture('默认空间任务标题');
   if(!await row.count())throw Object.assign(Error('默认空间未在工作空间列表显示独立行；最近任务同名标题数：'+await recent.count()+'，需确认原表展示位置'),{review:true});
   assert('本轮Session标题展示在默认工作空间下',displayed===1,{workspaceId:selected.id,sessionId:id,title:session.title,displayed});
   remaining.delete('默认空间侧栏展示本轮标题');
  });
  return;
 }
 if(number!==18&&number!==19)throw Error('首页工作空间步骤不支持该用例');

 const name='MW-CASE'+number+'-'+Date.now(),folder=path.join(dir,name);
 const before=(await workspaces(page)).items;
 const defaultSpace=before.find(item=>item.isDefault);
 resources.workspaceResources=await prepareWorkspaceResources(page,{target:{name,...(number===19?{path:folder}:{})}});
 await checkpointResources();

 const created=number===18
  ?await createDefaultWorkspace(page,name)
  :await createLocalWorkspace(page,folder,log,dir,control);
 await checkpointPage();
 const facts={id:created.id,name:created.name,path:created.path};
 await fs.writeFile(path.join(dir,'本轮工作空间.json'),JSON.stringify(facts,null,2));
 assert('产品真实注册本轮独立空间',!resources.workspaceResources.beforeIds.includes(created.id)&&created.name===name,facts);
 if(number===18){
  assert('新空间实际位于默认存储目录',Boolean(defaultSpace?.path)&&inside(defaultSpace.path,created.path),facts);
  remaining.delete('默认存储空间真实创建');
 }else{
  const picker=created.nativePicker;
  assert('原生目录框已回读目标并关闭',picker.dialogFound&&picker.dialogClosed&&samePath(picker.path,folder));
  assert('产品登记的本地路径与所选目录一致',samePath(created.path,folder),facts);
  remaining.delete('原生文件夹选择及空间注册');
 }

 const section=page.getByTestId('workspace-section-header').locator('button[aria-expanded]:not([aria-haspopup])');
 if(await section.getAttribute('aria-expanded')!=='true')await section.click();
 await workspaceRow(page,created.id).waitFor();
 const sidebar=await readWorkspaceSidebar(page);
 const selected=page.locator('main').last().getByRole('button',{name,exact:true}).filter({visible:true});
 assert('输入区选中本轮空间且侧栏显示相同名称',await selected.count()===1&&sidebar.rows.some(row=>row.id===created.id&&row.name===name),facts);
 await capture(number===18?'新建空间已显示':'本地空间已显示');
 remaining.delete(number===18?'输入区与侧栏展示新空间':'输入区与侧栏展示本地空间');
}
