import fs from 'node:fs/promises';
import path from 'node:path';
import {parseOwnedKnowledge} from './mobilework-knowledge-parse.mjs';
import {selectNativeFolder} from './mobilework-native-folder.mjs';
import {initializeTestPage} from './mobilework-initialize.mjs';
import {knowledgeClient,removeOwnedKnowledge,closeKnowledgeSettings,openKnowledgeSettings} from './mobilework-knowledge-api.mjs';

const visible=locator=>locator.filter({visible:true});
const button=(page,name)=>visible(page.getByRole('button',{name,exact:true}));
const tab=(page,name)=>visible(page.getByRole('tab',{name,exact:true}));
const blocked=message=>Object.assign(Error(message),{blocked:true});
const assert=(checks,name,pass,actual)=>{checks.push({name,pass:!!pass,...(actual===undefined?{}:{actual})});if(!pass)throw Error('断言失败：'+name);};

export async function runKnowledgeLifecycle(page,{config,checks,capture,log,dir,control}){
 const call=await knowledgeClient(page);
 const saveConfig=async(action)=>{
  const [response]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/knowledge/update_config'&&response.request().postDataJSON().id===created.id),action()]);
  const data=await response.json();
  if(!response.ok()||data.success!=='true')throw Error('知识库设置保存失败：HTTP '+response.status());
 };
 const before=await call('/knowledge/list'),name='MW-Autotest-KB-'+Date.now(),folder=path.join(dir,'隔离知识库');
 let created,owned,failure;
 const pending=new Set(['独立知识库及原生目录创建','全量解析及真实Wiki产物','更新设置保存与恢复','五个知识模块加载','首页引用开关','本轮知识库收尾']);
 try{
  await button(page,'知识库').click();
  assert(checks,'知识库面板提供搜索及管理入口',await visible(page.locator('input[placeholder="搜索"]')).count()===1&&await button(page,'管理知识库').count()===1);
  await button(page,'管理知识库').click();await page.waitForURL(/#\/knowledge$/);
  await button(page,'创建').click();
  await page.getByRole('textbox',{name:'知识库名称',exact:true}).fill(name);
  await selectNativeFolder(page,{folder,dir,log,control,open:()=>button(page,'选择文件夹').click()});
  // Native dismissal precedes the renderer's async pickDirectory result.
  await page.waitForFunction(expected=>{
   const field=document.querySelector('[data-knowledge-guide="storage"] p');
   return (field?.getAttribute('title')||field?.textContent||'').replaceAll('\\','/').toLowerCase()===expected;
  },folder.replaceAll('\\','/').toLowerCase(),{timeout:10000});
  await capture('知识库存储目录已回显');
  const create=page.locator('button[data-knowledge-guide="create"]');
  const [request]=await Promise.all([
   page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/knowledge/create'),
   create.click()
  ]);
  const payload=request.postDataJSON();
  await fs.writeFile(path.join(dir,'知识库创建请求.json'),JSON.stringify({name:payload.name,create_mode:payload.create_mode,storage_dir:payload.storage_dir},null,2));
  assert(checks,'创建请求提交了本轮隔离目录',path.resolve(payload.storage_dir).toLowerCase()===path.resolve(folder).toLowerCase());
  const createdAt=Date.now();
  while(Date.now()-createdAt<15000){
   created=(await call('/knowledge/list')).find(item=>item.name===name);
   if(created)break;
   await page.waitForTimeout(500);
  }
  assert(checks,'产品创建了本轮独立知识库',!!created&&!before.some(item=>item.id===created.id));
  owned={id:created.id,name:created.name,storageDir:created.storage_dir};
  await control.call('checkpoint',{knowledge:owned});
  assert(checks,'知识库使用原生选择的隔离目录',path.resolve(created.storage_dir).toLowerCase()===path.resolve(folder).toLowerCase(),created.storage_dir);
  for(const target of [created.source_dir[0],created.wiki_dir]){
   const relative=path.relative(folder,target);
   assert(checks,'源文件及Wiki目录位于本轮隔离目录内',relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),target);
  }
  await fs.writeFile(path.join(dir,'知识库创建记录.json'),JSON.stringify(created,null,2));
  await page.getByRole('button',{name,exact:true}).click();
  await tab(page,'源文件').waitFor();await capture('隔离知识库创建');
  pending.delete('独立知识库及原生目录创建');
  const fixture=path.join(created.source_dir[0],'海棠项目测试报告.md');
  const material='# 海棠026项目验收报告\n\n这是自动化测试合成材料，不涉及真实业务。\n\n项目代号：海棠026。负责人：林澈。预算：48000元。\n\n验收范围：登录、搜索、导出、权限四项功能。登录、搜索、导出已通过；权限功能待复核。\n\n风险：权限复核未结束，不应宣布全部验收通过。后续动作：林澈整理权限测试证据后再次评审。\n';
  await fs.writeFile(fixture,material);
  await fs.writeFile(path.join(dir,'合成知识库材料.md'),material);
  await call('/knowledge/refresh',{id:created.id});
  await button(page,'刷新').first().click();
  await page.getByText('海棠项目测试报告.md',{exact:true}).first().waitFor();
  assert(checks,'新增合成报告被源文件列表发现',await page.getByText('海棠项目测试报告.md',{exact:true}).count()>0);
  const parsed=await parseOwnedKnowledge({page,call,created,dir,assert:(name,pass,actual)=>assert(checks,name,pass,actual),capture,log});
  assert(checks,'知识产物保留报告关键事实',parsed.text.includes('海棠026')&&parsed.text.includes('林澈')&&(parsed.text.replace(/[,，\s]/g,'').includes('48000')||parsed.text.includes('4.8万')));
  pending.delete('全量解析及真实Wiki产物');
  const settings=await openKnowledgeSettings(page,{capture,log});
  await settings.getByRole('switch',{name:'自动更新',exact:true}).waitFor();
  const auto=settings.getByRole('switch',{name:'自动更新',exact:true});
  if(await auto.getAttribute('aria-checked')!=='true')await saveConfig(()=>auto.click());
  await settings.getByRole('button',{name:/每天|每日/}).click();
  const time=visible(page.locator('input[type="time"]'));
  await time.fill('23:59');await saveConfig(()=>button(page,'确定').click());await time.waitFor({state:'hidden'});
  const scheduled=await call('/knowledge/'+created.id);
  assert(checks,'自动更新开关与时间实际保存',scheduled.open_update===true&&scheduled.update_time==='23:59',{enabled:scheduled.open_update,time:scheduled.update_time});
  await capture('知识库更新设置');
  await saveConfig(()=>auto.click());await settings.getByRole('button',{name:'Close',exact:true}).click();
  await settings.waitFor({state:'hidden'});
  // Only this temporary library's schedule is changed and then disabled.
  assert(checks,'本轮临时知识库自动更新已关闭',(await call('/knowledge/'+created.id)).open_update===false);
  pending.delete('更新设置保存与恢复');
  for(const label of ['源文件','Wiki','知识卡片','知识记忆','知识图谱']){
   const target=tab(page,label);await target.click();
   await page.waitForFunction(()=>[...document.querySelectorAll('[role="tabpanel"]')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).some(e=>!/正在加载|加载中/.test(e.innerText)&&e.innerText.trim().length>0));
   const panel=visible(page.getByRole('tabpanel')).last(),text=await panel.innerText();
   assert(checks,'知识库模块选中且完成加载：'+label,await target.getAttribute('aria-selected')==='true'&&text.trim().length>0&&!/加载失败|请求失败|查询失败/.test(text),text.slice(0,250));
   await capture('知识库模块-'+label);
  }
  pending.delete('五个知识模块加载');
  await initializeTestPage(page,{...config,log});
  await button(page,'知识库').click();
  const search=visible(page.locator('input[placeholder="搜索"]'));await search.fill(name);
  const referenceState=await call('/knowledge/'+created.id);
  assert(checks,'解析后知识库可供任务引用',referenceState.open_ref===true&&!['create','update'].includes(referenceState.status),{status:referenceState.status,openRef:referenceState.open_ref});
  const row=visible(page.getByText(name,{exact:true})).locator('xpath=..');
  const choice=row.getByRole('switch');await choice.waitFor();
  const initial=await choice.getAttribute('aria-checked');
  checks.push({name:'新知识库在首页可搜索且默认未选中',pass:initial==='false',actual:initial});
  // open_ref controls availability; this switch selects the library for this task.
  if(initial==='true')await choice.click();
  await choice.click();assert(checks,'本任务知识库引用已选中',await choice.getAttribute('aria-checked')==='true');await capture('知识库引用开启');
  await choice.click();assert(checks,'本任务知识库引用可取消',await choice.getAttribute('aria-checked')==='false');
  pending.delete('首页引用开关');
  await button(page,'管理知识库').click();await page.waitForURL(/#\/knowledge$/);
  await page.getByRole('button',{name,exact:true}).click();await tab(page,'源文件').click();
  await capture('解析后知识库可再次管理');

 }catch(error){failure=error;await capture('知识库操作异常现场').catch(()=>{});throw error;}
 finally{
  if(owned){
   try{
    await closeKnowledgeSettings(page,owned);
    await removeOwnedKnowledge(call,owned);
    await initializeTestPage(page,{...config,log});
    await control.call('checkpoint',{knowledge:null});
    assert(checks,'仅移除本轮知识库注册并保留证据',(await call('/knowledge/list')).every(item=>item.id!==created.id));
    pending.delete('本轮知识库收尾');
   }catch(error){
    log('知识库收尾未完成',error.message);
    if(failure)failure.message+='；收尾未完成：'+error.message;
    else throw error;
   }
  }
  if(failure)failure.remainingSteps=[...pending];
 }
}
