import fs from 'node:fs/promises';
import path from 'node:path';
import {workspaceSessions,createWorkspaceSession,createDefaultWorkspace,workspaceRow,workspaceExpand,prepareWorkspaceResources} from './mobilework-workspaces.mjs';
import {inspectExplorer} from './mobilework-explorer.mjs';
import {openTaskMenu} from './mobilework-task-ui.mjs';

const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});

export async function runWorkspaceManagementSteps(context){
 const {number,page,dir,resources,remaining,assert,capture,checkpointPage,checkpointResources,recordPreparedSession}=context;
 const finish=step=>remaining.delete(step),save=(name,data)=>fs.writeFile(path.join(dir,name),JSON.stringify(data,null,2));
 const name='MW-CASE'+number+'-'+Date.now();
 resources.workspaceResources=await prepareWorkspaceResources(page,{target:{name}});await checkpointResources();
 const space=await createDefaultWorkspace(page,name);await checkpointPage();
 const section=page.getByTestId('workspace-section-header').locator('button[aria-expanded]:not([aria-haspopup])');
 if(await section.getAttribute('aria-expanded')!=='true')await section.click();
 const row=workspaceRow(page,space.id);await row.waitFor();
 if(await workspaceExpand(row).getAttribute('aria-expanded')!=='true')await workspaceExpand(row).click();
 await save('本轮空间.json',{id:space.id,name:space.name,path:space.path});
 assert('本轮空间已真实创建且独立于既有空间',!resources.workspaceResources.beforeIds.includes(space.id)&&space.name===name);
 finish('独立工作空间前置');await capture('本轮空间已创建');
 if(number===77){
  const baseline=await inspectExplorer(space.path,{reveal:true});await save('Explorer窗口基线.json',baseline);
  await row.locator('[data-workspace-row-header]').hover();
  await row.locator('[data-workspace-actions] button[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem',{name:'打开文件夹',exact:true}).click();
  const deadline=Date.now()+15000;let opened;
  do{opened=await inspectExplorer(space.path,{reveal:true});if(opened.windows.some(item=>item.targetVisible))break;await page.waitForTimeout(200);}while(Date.now()<deadline);
  await save('空间目录实际Explorer.json',opened);
  const added=opened.windows.filter(item=>item.targetVisible&&!baseline.windows.some(before=>before.hwnd===item.hwnd));
  if(added.length===1){resources.explorerWindow={path:space.path,hwnd:added[0].hwnd,reveal:true};await checkpointResources();}
  assert('空间菜单在Windows中实际打开或定位正确目录',opened.windows.some(item=>item.targetVisible),opened);
  finish('空间行打开文件夹');finish('Explorer实际目录与空间路径对应');
  await capture('空间目录已打开');return;
 }
 const tasks=[];
 // Task-list behavior needs real tasks, not model replies. Prepare empty
 // Sessions through the product API; all tested menu actions remain real UI.
 // Make task 3 older than tasks 1 and 2 so pinning changes visible order.
 for(const index of [3,1,2]){
  const title='MW'+number+'-任务'+index+'-'+space.id,session=await createWorkspaceSession(page,space.id,title);
  tasks.push({index,id:session.id,title,directory:session.directory});
  await save('本轮三个任务.json',tasks);await recordPreparedSession(session);
 }
 await save('本轮三个任务.json',tasks);
 const actual=await workspaceSessions(page,space.id);
 assert('三条任务均由产品创建且归属独立空间',tasks.every(task=>actual.some(item=>item.id===task.id&&item.title===task.title)&&path.relative(space.path,task.directory)&&!path.relative(space.path,task.directory).startsWith('..')));
 if(await workspaceExpand(row).getAttribute('aria-expanded')==='true')await workspaceExpand(row).click();
 await workspaceExpand(row).click();
 for(const task of tasks)await row.getByText(task.title,{exact:true}).waitFor();
 finish('空间内三个独立任务前置');
 const workspaceTask=title=>row.locator('[data-slot="sidebar-menu-sub-item"]').filter({has:page.getByText(title,{exact:true})});
 const knownTitles=tasks.map(task=>task.title);
 const titles=()=>row.locator('[data-slot="sidebar-menu-sub-item"]').evaluateAll((items,known)=>items.map(e=>known.find(title=>e.innerText.includes(title))).filter(Boolean),knownTitles);
 const menu=title=>openTaskMenu(page,title,row);
 if(number===78){
  const target=tasks.find(task=>task.index===3),before=await titles(),task=workspaceTask(target.title);
  assert('目标三号任务置顶前不在首位',before.length===3&&before[0]!==target.title,{before,target});
  resources.taskPin={title:target.title,baseline:false,workspaceId:space.id,sessionId:target.id};await checkpointResources();
  await menu(target.title);await page.getByRole('menuitem',{name:'置顶',exact:true}).click();
  await task.locator('[data-pinned-session="true"]').waitFor();
  await page.waitForFunction(({id,title})=>document.getElementById(id)?.querySelector('[data-slot="sidebar-menu-sub-item"]')?.textContent.includes(title),{id:space.id,title:target.title});
  const after=await titles();await save('空间任务置顶前后.json',{before,after,target});
  assert('三号任务在本空间真实置顶并移动到首位',after[0]===target.title&&await task.locator('[data-pinned-session="true"]').count()===1);
  await capture('空间内三号任务已置顶');finish('空间行任务置顶及顺序');
  await menu(target.title);await page.getByRole('menuitem',{name:'取消置顶',exact:true}).click();
  await task.locator('[data-pinned-session="true"]').waitFor({state:'hidden'});
  await page.waitForFunction(({id,before})=>JSON.stringify([...document.getElementById(id).querySelectorAll('[data-slot="sidebar-menu-sub-item"]')].map(e=>before.find(title=>e.innerText.includes(title))).filter(Boolean))===JSON.stringify(before),{id:space.id,before});
  assert('取消置顶后标记移除且空间任务顺序恢复',await task.locator('[data-pinned-session="true"]').count()===0&&JSON.stringify(await titles())===JSON.stringify(before));
  await save('取消置顶恢复顺序.json',{before,restored:await titles()});await capture('取消置顶已恢复原顺序');
  delete resources.taskPin;await checkpointResources();finish('取消置顶恢复空间顺序');
 }else{
  const target=tasks.find(task=>task.index===1),renamed='111-'+target.id;
  await menu(target.title);await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
  const input=page.getByRole('textbox',{name:'会话名称',exact:true}).filter({visible:true});
  await input.fill(renamed);await input.press('Enter');await input.waitFor({state:'hidden'});
  await row.getByText(renamed,{exact:true}).waitFor();
  const updated=await workspaceSessions(page,space.id);await save('重命名后真实任务.json',updated.map(({id,title})=>({id,title})));
  assert('空间内指定任务持久化新名称',updated.find(item=>item.id===target.id)?.title===renamed&&await row.getByText(target.title,{exact:true}).count()===0);
  assert('其余任务编号与名称未变',tasks.filter(item=>item.id!==target.id).every(task=>updated.some(item=>item.id===task.id&&item.title===task.title)));
  finish('空间行任务重命名');finish('持久化名称及其余任务隔离');await capture('空间内任务重命名已保存');
 }
}
