import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {snapshotDraft} from './mobilework-isolation.mjs';
import {openExpertWorkspace} from './mobilework-market-ui.mjs';
import {restoreModuleNavigation,reloadOwnedModule} from './mobilework-module-navigation.mjs';
import {waitMarketList} from './mobilework-staff-market.mjs';
import {prepareWorkspaceResources,workspaces} from './mobilework-workspaces.mjs';
import {readAutomation,disableOwnedAutomation,waitAutomation,findAutomationSession} from './mobilework-automation-resources.mjs';
import {readArtifact} from './client-case-checks.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const formOf=page=>page.locator('div').filter({has:page.locator('input[placeholder="请输入任务名称"]')}).filter({visible:true}).filter({has:button(page,'取消')}).last();
const planRow=(page,name)=>page.getByTestId('automation-job-list').locator('div.group.h-14').filter({has:page.getByText(name,{exact:true})});

async function openAutomation(context){
 const {page,resources,checkpointResources}=context,draft=await snapshotDraft(page);
 if(draft.text||draft.skills.length||draft.selection.length)throw blocked('自动化模块检查前存在未知输入，未切换');
 resources.moduleNavigation={originUrl:draft.url,targetHash:'#/automation'};await checkpointResources();
 await button(page,'自动化: 任务编排').click();
 await page.waitForURL(url=>url.hash==='#/automation');
 await page.getByTestId('automation-job-list').or(page.getByTestId('automation-empty')).waitFor();
 await button(page,'从模板添加').waitFor();
}

async function selectDay(panel,date){
 // These selectors follow the shipped calendar: the grey cells belong to the
 // preceding/following month. Do not choose an identically numbered grey cell.
 const candidates=await panel.getByRole('button',{name:String(date.getDate()),exact:true}).all();
 const usable=[];
 for(const candidate of candidates)if(!(await candidate.getAttribute('class')).includes('cursor-not-allowed'))usable.push(candidate);
 if(usable.length!==1)throw blocked('日历中未唯一识别当前月份目标日期');
 await usable[0].click();
}

const monthLabel=date=>new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long'}).format(date);
async function calendarFor(page,date,{range=false}={}){
 const popup=page.locator('[data-slot="popover-content"]').filter({visible:true});await popup.waitFor();
 // The actual calendar root has width 280px; read its heading and use the
 // shipped header's next-month control rather than editing React state.
 // A range popup displays two months. Select the panel by its exact month.
 const target=popup.locator('div[class*="w-[280px]"]').filter({has:page.getByText(monthLabel(date),{exact:true})});
 if(!await target.count()){
  const root=popup.locator('div[class*="w-[280px]"]').last();
  const next=root.locator(':scope > div').first().locator('button').nth(range?0:2);
  await next.click();
 }
 await target.waitFor();return {popup,panel:target};
}

async function futureSchedule(page,form,once){
 const target=new Date();target.setDate(target.getDate()+2);target.setHours(9,0,0,0);
 if(once){
  await button(form,'单次').click();await button(form,'选择执行日期时间').click();
  const {popup,panel}=await calendarFor(page,target);await selectDay(panel,target);
  const columns=popup.locator('div.overflow-y-auto').filter({has:page.locator('button[data-val]')});
  await columns.nth(0).locator('button[data-val="9"]').click();
  await columns.nth(1).locator('button[data-val="0"]').click();
  await button(popup,'确定').click();await popup.waitFor({state:'hidden'});
 }else{
  await button(form,'周期').click();await button(form,'每日').waitFor();
  await button(form,'选择日期范围').click();
  const {popup,panel}=await calendarFor(page,target,{range:true});
  await selectDay(panel,target);await selectDay(panel,target);await popup.waitFor({state:'hidden'});
 }
 return {date:target.toLocaleDateString('sv-SE'),timestamp:target.getTime()};
}

async function rowAction(page,row,index,tooltip){
 await row.hover();const action=row.locator('button').filter({has:page.locator('svg')}).nth(index);
 await action.hover();await page.locator('[data-slot="tooltip-content"][data-open]:not([data-closed])').filter({visible:true,hasText:tooltip}).waitFor();
 await action.click();
}

export async function runAutomationSteps(context){
 const {number,page,resources,dir,remaining,assert,capture,checkpointResources,adoptExternalSession,getData,saveTrace,control}=context;
 const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2)),finish=step=>remaining.delete(step);
 if(number===97){
  const errors=[],observations=[],onError=error=>errors.push(error.message);page.on('pageerror',onError);
  try{
   for(const section of [
    {name:'数智员工',entry:'RPA流程助手',hash:'#/experts/staff',ready:async()=>{await page.getByRole('tab',{name:'数智员工市场',exact:true}).click();await waitMarketList(page);}},
    {name:'专家',entry:'专家',hash:'#/experts/experts',ready:async()=>{await button(page,'我的专家').waitFor();}},
    {name:'技能',entry:'技能',hash:'#/experts',ready:async()=>{await button(page,'技能市场').click();}},
    {name:'工具',entry:'工具',hash:'#/experts/connectors',ready:async()=>{await button(page,'我的工具').waitFor();}}
   ]){
    const errorStart=errors.length;
    let observation;
    try{
    await openExpertWorkspace(context,{section:section.entry,targetHash:section.hash});await section.ready();
    if(section.name!=='数智员工'){
     await page.getByText(/^(加载中\.{3}|正在加载.*)$/).filter({visible:true}).waitFor({state:'hidden',timeout:45000});
     const content=page.locator('div[role="button"]').filter({visible:true}).first();
     const empty=page.getByText(/^(暂无.*|没有找到.*|未找到.*)$/).filter({visible:true}).first();
     await content.or(empty).first().waitFor({timeout:45000});
    }
    const visibleErrors=await page.locator('main').last().getByText(/加载失败|请求失败|发生错误|获取.*失败/).filter({visible:true}).allTextContents();
    observation={module:section.name,url:page.url(),pageErrors:errors.slice(errorStart),visibleErrors};
    finish(section.name+'模块加载');
    }catch(error){
     observation={module:section.name,url:page.url(),pageErrors:errors.slice(errorStart),stepError:error.message};
    }
    await save(section.name+'模块观察.json',observation);await capture(section.name+'模块加载观察');observations.push(observation);
    await restoreModuleNavigation(page,resources);await checkpointResources();
   }
  }finally{page.off('pageerror',onError);}
  for(const observation of observations)assert(observation.module+'真实页面结束加载且无报错',!observation.stepError&&observation.pageErrors.length===0&&observation.visibleErrors.length===0,observation);
  return;
 }

 const suffix=randomUUID().slice(0,8),name='MW-AUTOTEST-'+String(number).padStart(3,'0')+'-'+suffix,renamed=name+'-改名';
 const baseline=await readAutomation(page);
 resources.automation={accountId:baseline.accountId,beforeIds:baseline.ids,hashes:baseline.hashes,names:[name,renamed],originUrl:page.url(),id:null,creating:false,runPending:false,beforeSessions:[],runStartedAt:0};
 const owned=resources.automation;await checkpointResources();
 await openAutomation(context);
 if(number===99){
  await button(page,'从模板添加').click();await page.getByText('每日 AI 新闻推送',{exact:true}).click();
 }else{
  // There is another 新建任务 in the sidebar. Scope by the template button's
  // actual header, after route and list readiness, before opening this menu.
  const header=button(page,'从模板添加').locator('xpath=..');
  await button(header,'新建任务').click();await page.getByRole('menuitem',{name:'手动创建',exact:true}).click();
 }
 const form=formOf(page),nameInput=form.locator('input[placeholder="请输入任务名称"]'),editor=form.locator('[contenteditable="true"][role="textbox"]');
 await nameInput.waitFor();
 const template=number===99?{name:await nameInput.inputValue(),prompt:await editor.innerText()}:null;
 if(template){
  await save('模板真实预填.json',template);
  assert('新闻模板真实预填名称和任务指令',template.name==='每日 AI 新闻推送'&&template.prompt.trim().length>20&&/AI|人工智能/i.test(template.prompt));finish('模板真实预填');
 }
 await nameInput.fill(name);
 const prompt=number===98?'只读检查当前任务目录，汇总当前可观察的系统运行环境和一级文件列表。不得修改系统配置、写文件、访问外部服务或发送消息；无法读取的指标请说明。':number===100?'这是合成自动化试运行 '+name+'。请在当前任务目录创建“自动化试运行结果.json”，内容为对象：marker='+name+'、items=[12,18,30]、total=60。不要写其他目录、不联网、不发送消息。最后说明文件位置。':'这是一项合成只读巡检 '+name+'。仅列出当前任务目录，不修改文件或系统，不联网、不发送消息。';
 if(!template){
  // The empty inline editor has no clickable box until it contains text.
  // Focus the actual textbox, then use Chromium's real text input path.
  await editor.focus();await page.keyboard.insertText(prompt);
  if((await editor.innerText()).trim()!==prompt)throw Error('自动化表单未保留完整任务指令，未提交');
 }
 assert('自动化表单保留自动模型',await button(form,'自动').count()===1);
 assert('自动化表单包含完全访问权限',(await form.innerText()).includes('完全访问权限'));
 const cycle=number===98||number===103;
 const schedule=await futureSchedule(page,form,!cycle);await capture('自动化任务真实配置');
 owned.creating=true;await checkpointResources();
 await button(form,'添加').click();await form.waitFor({state:'hidden',timeout:30000});
 const created=await waitAutomation(page,async()=>(await readAutomation(page,owned)).job,'提交后未找到本轮唯一自动化定义');
 owned.id=created.id;owned.creating=false;await checkpointResources();
 await save('本轮自动化创建.json',created);
 assert('真实UI创建独立计划且配置已持久化',!owned.beforeIds.includes(created.id)&&created.name===name&&created.prompt===(template?template.prompt.trim():prompt)&&!created.model&&created.modelLabel==='自动'&&created.fullAccess===true,created.id);
 const expectedDay=schedule.date;
 assert('保存的日期和09点调度对应界面选择',created.cron==='0 9 * * *'&&new Date(created.startDate).toLocaleDateString('sv-SE')===expectedDay&&new Date(created.endDate).toLocaleDateString('sv-SE')===expectedDay&&created.startDate>Date.now()&&created.scheduleKind===(cycle?'cycle':'once')&&created.runOnce===!cycle,{cron:created.cron,scheduleKind:created.scheduleKind,startDate:created.startDate,endDate:created.endDate});
 await planRow(page,name).waitFor();await capture('已安排列表本轮任务');finish('真实UI创建与保存');finish('执行配置与未来时间');finish('已安排列表展示');
 if(number===102){
  // Product UI deletion cascades to run history and workspace. Only our new,
  // never-run plan is eligible; ordinary cleanup still preserves all history.
  const state=await readAutomation(page,owned),job=state.job;
  if(job.sessionIds?.length||job.autoWorkspaceId||job.executionWorkspaceId||state.runs.length)throw blocked('本轮计划意外产生执行资源，未进行级联删除');
  await rowAction(page,planRow(page,name),2,'删除');
  const confirm=page.getByRole('dialog').filter({visible:true,hasText:name});await confirm.waitFor();
  const warning=await confirm.innerText();await save('任务删除确认.json',{id:job.id,name,warning});await capture('本轮任务永久删除确认');
  assert('删除确认说明永久删除和停止后续运行',/永久删除/.test(warning)&&/停止.*(?:后续|运行)/.test(warning));finish('真实删除及确认提示');
  await button(confirm,'删除').click();await confirm.waitFor({state:'hidden'});
  await waitAutomation(page,async()=>!(await readAutomation(page,owned)).ids.includes(job.id),'本轮计划删除尚未持久化');
  await reloadOwnedModule(page,resources);await button(page,'从模板添加').waitFor();
  const after=await readAutomation(page,owned);
  assert('重载后本轮计划ID和已安排行均消失',!after.ids.includes(job.id)&&await planRow(page,name).count()===0);
  assert('用户既有计划定义保持不变',JSON.stringify(after.hashes)===JSON.stringify(owned.hashes));
  await save('任务删除后核对.json',{deletedId:job.id,existingDefinitionHashes:after.hashes});await capture('本轮自动化任务已删除');finish('删除持久化与原有计划保护');return;
 }
 if(number===103){
  const toggle=planRow(page,name).getByRole('switch');
  for(const enabled of [false,true,false]){
   if((await toggle.getAttribute('aria-checked')==='true')===enabled)throw Error('任务开关前置状态与预期相反');
   await toggle.click();
   const after=await waitAutomation(page,async()=>{const job=(await readAutomation(page,owned)).job;return job?.enabled===enabled&&job;},'真实开关状态未持久化');
   await reloadOwnedModule(page,resources);await planRow(page,name).waitFor();
   assert('周期任务'+(enabled?'重新启用':'关闭')+'后重载状态一致',after.id===created.id&&(await toggle.getAttribute('aria-checked')==='true')===enabled&&after.startDate>Date.now()&&after.cron===created.cron&&after.scheduleKind==='cycle');
   await save('周期任务'+(enabled?'开启':'关闭')+'-'+Date.now()+'.json',after);await capture(enabled?'周期任务已启用':'周期任务已关闭');
   finish(enabled?'真实开启与重载持久化':'真实关闭与重载持久化');
  }
  finish('测试定时计划关闭');
  // Persisted enabled state proves scheduling eligibility only. The original
  // case also requires actual due-time behavior, not observed by this phase.
  throw Object.assign(Error('开关及持久化已核对；实际到点关闭不触发、重开后触发的调度行为尚未观察'),{review:true});
 }
 // Disable immediately after verifying persistence, before any model work.
 await disableOwnedAutomation(page,owned);await checkpointResources();finish('测试定时计划关闭');
 if(number===98||number===99)return;
 // IPC persistence does not refresh the row's React closure. Reload before
 // Edit/Trial so it receives the already-disabled definition.
 await reloadOwnedModule(page,resources);await page.getByTestId('automation-job-list').waitFor();await planRow(page,name).waitFor();
 if(number===101){
  await rowAction(page,planRow(page,name),1,'编辑');const edit=formOf(page);
  assert('编辑表单真实回填本轮名称和指令',await edit.locator('input[placeholder="请输入任务名称"]').inputValue()===name&&(await edit.locator('[contenteditable="true"][role="textbox"]').innerText()).trim()===prompt);finish('真实编辑入口及回填');
  await edit.locator('input[placeholder="请输入任务名称"]').fill(renamed);await button(edit,'保存').click();await edit.waitFor({state:'hidden'});
  await reloadOwnedModule(page,resources);await page.getByTestId('automation-job-list').waitFor();await planRow(page,renamed).waitFor();
  const after=(await readAutomation(page,owned)).job;
  const stable=job=>Object.fromEntries(Object.entries(job).filter(([key])=>!['name','updatedAt','enabled'].includes(key)));
  assert('重载后同ID改名持久化且其他配置未变',after.id===created.id&&after.name===renamed&&after.enabled===false&&JSON.stringify(stable(after))===JSON.stringify(stable(created)));
  await save('编辑后重载回读.json',after);await capture('自动化改名重载持久化');finish('同ID改名及配置持久化');return;
 }

 // The product can create/switch a workspace only when trial starts. Avoid
 // restoring/reloading workspace state for a failure in the plan form.
 resources.workspaceResources=await prepareWorkspaceResources(page);await checkpointResources();
 owned.beforeSessions=(created.sessionIds||[]).map(link=>link.sessionId);owned.runStartedAt=Date.now();owned.runPending=true;await checkpointResources();
 await rowAction(page,planRow(page,name),0,'试运行');
 const link=await waitAutomation(page,()=>findAutomationSession(page,owned),'试运行未关联真实Session，保留后台归属',{timeoutMs:90000});
 const workspace=(await workspaces(page)).items.find(w=>w.id===link.workspaceId);
 if(!workspace)throw blocked('试运行关联空间尚未可读取，保留计划与Session归属');
 await save('自动化真实Session交接.json',{jobId:owned.id,...link,workspacePath:workspace.path});
 await adoptExternalSession({sessionId:link.sessionId,workspaceId:link.workspaceId,expectedPrompt:prompt,workspacePath:workspace.path});finish('真实试运行及Session交接');
 const run=await waitAutomation(page,async()=>(await readAutomation(page,owned)).runs.find(r=>r.sessionId===link.sessionId&&r.ts>=owned.runStartedAt),'模型结束但自动化执行记录尚未落库');
 owned.runPending=false;await checkpointResources();await save('自动化实际执行记录.json',run);
 assert('真实试运行记录完成且对应本轮计划和Session',run.jobId===owned.id&&run.sessionId===link.sessionId&&run.workspaceId===link.workspaceId&&run.status==='completed',run);finish('真实终态及执行记录');
 const text=await readArtifact(control.directory,'自动化试运行结果.json'),artifact=JSON.parse(text);
 await fs.writeFile(path.join(dir,'自动化试运行结果.json'),text);
 assert('实际Session产物含本轮标记及正确合计',artifact.marker===name&&JSON.stringify(artifact.items)==='[12,18,30]'&&artifact.total===60);
 const calls=getData().messages.flatMap(m=>m.parts||[]).filter(p=>p.type==='tool'&&p.state?.status==='completed');
 assert('本Session实际工具完成产物写入',calls.some(p=>JSON.stringify(p.state.input).includes('自动化试运行结果.json')));finish('真实产物与工具证据');await saveTrace();
 await control.acquire(page,'INTERACTING');
 resources.moduleNavigation={originUrl:page.url(),targetHash:'#/automation'};await checkpointResources();
 await button(page,'自动化: 任务编排').click();await page.waitForURL(url=>url.hash==='#/automation');
 const completed=page.getByTestId('automation-run-list');await completed.waitFor();
 const row=completed.locator('div.group').filter({has:page.getByText(name,{exact:true})});await row.waitFor();
 assert('已完成界面展示本轮真实执行结果',/完成|成功/.test(await row.innerText()));await capture('自动化已完成真实结果');finish('已完成列表真实结果');
}
