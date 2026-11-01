import fs from 'node:fs/promises';
import path from 'node:path';
import {workspaces} from './mobilework-workspaces.mjs';
import {readInstalledSkills,releaseSkillResources,waitForSkillInstall,settleSkillReload} from './mobilework-skill-resources.mjs';
import {restoreModuleNavigation} from './mobilework-module-navigation.mjs';
import {openExpertWorkspace,searchMarketCard} from './mobilework-market-ui.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});

export async function runSkillManagementSteps(context){
 const {page,dir,control,remaining,assert,capture,resources,checkpointPage,log}=context;
 const workspaceId=page.url().match(/\/workspace\/([^/]+)/)[1];
 const workspace=(await workspaces(page)).items.find(w=>w.id===workspaceId),targetName='数据分析';
 let owned,failure;
 const checkpoint=()=>control.call('checkpoint',{skillResources:owned});
 try{
  await openExpertWorkspace(context,{section:'技能',targetHash:'#/experts'});
  await page.getByRole('button',{name:'技能市场',exact:true}).click();
  const target=await searchMarketCard(page,targetName),before=await readInstalledSkills(page,workspace.path);
  await fs.writeFile(path.join(dir,'技能安装基线.json'),JSON.stringify({workspaceId,targetName,installedBefore:before},null,2));
  const install=target.getByRole('button',{name:'安装',exact:true});
  if(!await install.count())throw blocked('原表数据分析技能已安装，保留用户安装；本条新增安装/卸载分支需未安装前置');
  owned={projectDir:workspace.path,targetName,installedBefore:before,id:null,pending:true};await checkpoint();
  await capture('数据分析安装前');await install.click();
  await waitForSkillInstall(page,targetName);
  const added=(await readInstalledSkills(page,workspace.path)).filter(id=>!before.includes(id));
  await fs.writeFile(path.join(dir,'技能新增目录.json'),JSON.stringify({targetName,added},null,2));
  if(added.length!==1)throw blocked('市场安装未对应唯一新增技能目录，保留资源归属待核对');
  owned.id=added[0];owned.pending=false;await checkpoint();
  assert('市场安装完成且实际新增唯一技能目录',true,{targetName,id:owned.id});remaining.delete('市场真实新增安装');
  await capture('市场数据分析已安装');
  await page.getByRole('button',{name:/^已安装技能\(/}).click();
  const more=page.getByRole('button',{name:'打开'+targetName+'更多操作',exact:true});await more.waitFor({timeout:30000});
  assert('已安装技能页显示本轮新增技能及操作菜单',await more.count()===1);remaining.delete('已安装页真实展示');
  await capture('已安装页本轮技能');await more.click();
  await page.getByRole('menuitem',{name:'卸载',exact:true}).click();
  const confirm=page.getByRole('dialog').filter({visible:true}).filter({hasText:targetName});await confirm.waitFor();
  assert('卸载确认框明确指向本轮目标',(await confirm.innerText()).includes(targetName));await capture('本轮技能卸载确认');
  await confirm.getByRole('button',{name:'卸载',exact:true}).click();await confirm.waitFor({state:'hidden'});
  await settleSkillReload(page,{waitForPrompt:true});
  await page.waitForFunction(async({projectDir,id})=>!(await window.__MOBILEWORK__.invoke('engine:listSkills',{projectDir})).skills.includes(id),{projectDir:workspace.path,id:owned.id},{timeout:30000});
  await more.waitFor({state:'hidden'});
  const after=await readInstalledSkills(page,workspace.path);
  await fs.writeFile(path.join(dir,'技能卸载实际结果.json'),JSON.stringify({targetName,removed:owned.id,before,after},null,2));
  assert('卡片菜单卸载后UI及真实目录均移除本轮技能',!after.includes(owned.id)&&await more.count()===0);remaining.delete('卡片菜单卸载与目录移除');
  assert('卸载未改变原有技能集合',JSON.stringify([...after].sort())===JSON.stringify([...before].sort()));remaining.delete('原有技能隔离与恢复');
  await control.call('checkpoint',{skillResources:null});owned=null;await capture('卸载后已安装列表');
 }catch(error){failure=error;await capture('技能管理异常现场').catch(e=>log('异常截图失败',e.message));}
 finally{
  try{
   if(owned){await releaseSkillResources(page,owned);await control.call('checkpoint',{skillResources:null});}
   await restoreModuleNavigation(page,resources);await checkpointPage();
  }catch(error){log('技能管理收尾未完成',error.message);if(failure)failure.message+='；收尾：'+error.message;else failure=error;}
 }
 if(failure)throw failure;
}
