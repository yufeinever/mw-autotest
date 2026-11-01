import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectClient} from '../local-console/client-connection.mjs';
import {uniqueClientPage} from '../local-console/client-page.mjs';
import {normalizeConfig} from '../local-console/policy.mjs';
import {getClientCase,caseSheet,caseWorkbook} from './client-case-catalog.mjs';
import {createRunDirectory,createEvidenceRecorder,beijingLogTime} from './mobilework-evidence.mjs';
import {createTaskControl} from './mobilework-task-control.mjs';
import {waitStep} from './mobilework-run-policy.mjs';
import {workspaces} from './client-ui-case-runner.mjs';
import {snapshotDraft,clearOwnedDraft,draftOwnership} from './mobilework-isolation.mjs';
import {runKnowledgeLifecycle} from './mobilework-knowledge-case.mjs';
import {initializeTestPage} from './mobilework-initialize.mjs';
import {readExpertCatalog,releaseExpertResources,waitForExpertInstall} from './mobilework-expert-resources.mjs';
import {prepareToolResources,readOwnedToolState,releaseToolResources} from './mobilework-tool-resources.mjs';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
import {readInstalledSkills,releaseSkillResources,waitForSkillPicker} from './mobilework-skill-resources.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const blocked=message=>Object.assign(Error(message),{blocked:true});
const visible=locator=>locator.filter({visible:true});
const exactToolbar=(page,name)=>visible(page.locator('button[aria-label="'+name+'"]'));

async function openPanel(page,name,selectedLabel=''){
 let trigger=exactToolbar(page,name);
 if(await trigger.count()!==1&&selectedLabel)trigger=exactToolbar(page,selectedLabel);
 if(await trigger.count()!==1)throw blocked('未找到首页配置入口：'+name);
 await trigger.click();await page.waitForTimeout(300);
}
async function closePanel(page){await page.keyboard.press('Escape');await page.waitForTimeout(200);}
function assert(checks,name,pass,actual){checks.push({name,pass:Boolean(pass),...(actual===undefined?{}:{actual})});if(!pass)throw Error('断言失败：'+name);}
function selectedMode(button){return /bg-\[color:var\(--mw-brand-bg\)\]|text-\[color:var\(--mw-brand\)\]/.test(button.className||'');}

async function runMode(page,config,checks,capture,log){
 await openPanel(page,'模式');
 const options=visible(page.getByRole('button',{name:/^(执行模式|计划模式)$/}));
 assert(checks,'模式面板展示执行模式和计划模式',await options.count()===2,await options.allTextContents());
 const initial=(await options.nth(0).evaluate(selectedMode))?'执行模式':(await options.nth(1).evaluate(selectedMode))?'计划模式':'';
 assert(checks,'模式面板存在当前选中状态',Boolean(initial),await options.allTextContents());
 await capture('模式面板');
 const target=initial==='执行模式'?'计划模式':'执行模式';
 try{
  for(const [name,words]of [['执行模式',['执行','敏感','确认']],['计划模式',['计划','确认','执行']]]){
   await visible(page.getByRole('button',{name,exact:true})).hover();
   const tip=visible(page.locator('[data-slot="tooltip-content"]'));await tip.waitFor();
   const text=await tip.innerText();assert(checks,'模式悬停提示说明行为：'+name,words.every(word=>text.includes(word)),text);
  }
  await waitStep(page,config);await page.getByRole('button',{name:target,exact:true}).click();
  await options.first().waitFor({state:'hidden'});await openPanel(page,'模式');
  const switched=await visible(page.getByRole('button',{name:target,exact:true})).evaluate(selectedMode);
  assert(checks,'模式切换后目标选项被选中',switched,target);await capture('模式切换后');
 }finally{
  const original=visible(page.getByRole('button',{name:initial,exact:true}));
  if(!await original.count())await openPanel(page,'模式');
  await original.click();await openPanel(page,'模式');
  assert(checks,'模式切换后恢复原选项',await original.evaluate(selectedMode),initial);await closePanel(page);
 }
 log('模式面板检查完成',initial+' → '+target+' → '+initial);
}

async function runSkill(page,config,checks,capture,log,control,dir){
 const gaps=[];
 await openPanel(page,'技能');
 const search=visible(page.locator('input[placeholder="输入名称搜索..."]'));
 assert(checks,'技能面板提供搜索框',await search.count()===1);
 const baseline=await waitForSkillPicker(page),rows=baseline.items.filter(item=>item.role==='checkbox');
 if(!rows.length)throw blocked('当前工作空间未加载可选技能，无法验证技能选择；未安装或伪造技能');
 assert(checks,'技能面板存在可选技能卡片',rows.length>0,rows.length);
 await search.fill('知识库');
 const knowledge=await waitForSkillPicker(page,{query:'知识库'});
 assert(checks,'技能搜索按真实机器名及显示名返回完整候选',JSON.stringify(knowledge.items.map(item=>item.id))===JSON.stringify(knowledge.expectedIds),{keyword:'知识库',expectedIds:knowledge.expectedIds,actual:knowledge.items,empty:knowledge.empty});
 if(!knowledge.items.some(item=>item.role==='checkbox')){gaps.push('当前输入区已加载技能无知识库样例，已验证完整筛选结果，原表相关技能命中分支未覆盖');log('原表搜索样例未满足','已加载名称：'+baseline.skills.map(skill=>skill.name+'（'+skill.title+'）').join('、'));}
 await search.clear();
 const clearedSearch=await waitForSkillPicker(page),selectable=clearedSearch.items.filter(item=>item.role==='checkbox'&&!item.disabled);
 assert(checks,'清空搜索恢复完整技能列表',JSON.stringify(clearedSearch.items.map(item=>item.id))===JSON.stringify(baseline.items.map(item=>item.id)),clearedSearch.items);
 if(!selectable.length)throw blocked('当前可选技能均为待生效状态，未操作不可用条目');
 const last=await waitForSkillPicker(page,{targetId:selectable.at(-1).id});
 try{await last.element.scrollIntoViewIfNeeded();assert(checks,'技能列表末项可滚动到可见区域',await last.element.isVisible());}finally{await last.element.dispose();}
 const target=clearedSearch.skills.find(skill=>skill.id===selectable[0].id),label=target.title,initial=selectable[0].checked==='true';
 const hovered=await waitForSkillPicker(page,{targetId:target.id});
 try{
  await hovered.element.hover();const tip=visible(page.locator('[data-slot="tooltip-content"]'));await tip.waitFor();
  const tipText=await tip.innerText();assert(checks,'技能悬停显示名称及说明',tipText.includes(label)&&tipText.trim().length>label.length,tipText);
 }finally{await hovered.element.dispose();}
 await search.fill(label);
 const result=await waitForSkillPicker(page,{query:label,targetId:target.id});
 assert(checks,'技能搜索能返回真实身份的目标技能',Boolean(result.element),{id:target.id,name:target.name,title:label,candidates:result.items});
 let owned,emptyDraft;
 const remove=page.locator('[contenteditable="true"]').filter({visible:true}).locator('[data-skill-remove='+JSON.stringify(target.name)+']');
 try{
  try{
   await capture('技能面板搜索');
   emptyDraft=await snapshotDraft(page);
   if(initial||emptyDraft.text||emptyDraft.skills.length||emptyDraft.selection.length)throw blocked('技能选择前不是本轮空草稿，未接管未知内容');
   // Register the exact intended mutation before the click, including stop/failure.
   owned={...emptyDraft,skills:[target.name]};await control.checkpointDraft(owned);
   if(!(await draftOwnership(page,emptyDraft)).matches)throw blocked('技能选择前草稿已变化，未点击');
   await result.element.click();
  }finally{await result.element.dispose();}
  // The chip's remove button is hidden until its actual chip is hovered.
  await remove.waitFor({state:'attached'});
  if(!(await draftOwnership(page,owned)).matches)throw blocked('选中后的实际草稿与预登记技能不符，保留现场');
  const selected=(await waitForSkillPicker(page,{query:label})).items.find(item=>item.id===target.id);assert(checks,'技能卡点击后状态切换',(selected.checked==='true')!==initial,selected.checked);
  assert(checks,'选择技能实际生成输入区chip',await remove.count()===1,owned.skills);
  await visible(page.getByText('Mobile熠动，Work智简',{exact:true})).first().click();
  await search.waitFor({state:'hidden'});assert(checks,'点击空白区域关闭技能面板',await search.count()===0);
  // Installed KAn renderer: button -> icon span -> visible .group chip.
  await remove.locator('xpath=../..').hover();await remove.waitFor({state:'visible'});await remove.click();await remove.waitFor({state:'detached'});
  assert(checks,'输入区技能chip可删除',await remove.count()===0);
  if(!(await draftOwnership(page,emptyDraft)).matches)throw blocked('技能删除后未恢复本轮空草稿，保留现场');
  owned=emptyDraft;await control.checkpointDraft(owned);
  await openPanel(page,'技能');const restored=(await waitForSkillPicker(page)).items.find(item=>item.id===target.id);assert(checks,'技能取消后恢复原状态',(restored.checked==='true')===initial,restored.checked);await closePanel(page);
 }finally{
  if(await search.count())await closePanel(page);
  if(owned){
   // A failed/interrupted click may leave the pre-registered empty state intact.
   // Only these two known states belong to this operation; never adopt a snapshot.
   if((await draftOwnership(page,owned)).matches)assert(checks,'技能用例清理本条草稿及选择',await clearOwnedDraft(page,owned,config));
   else if(!(await draftOwnership(page,emptyDraft)).matches)throw blocked('技能收尾草稿不属于预登记状态，保留现场');
   await control.call('checkpoint',{draft:null});
  }
 }
 log('技能面板检查完成',label+'；原状态='+initial);
 let resources;
 try{
  await openPanel(page,'技能');await visible(page.getByRole('button',{name:'管理技能',exact:true})).click();
  await page.waitForURL(/#\/experts$/);
  await visible(page.getByRole('button',{name:'技能市场',exact:true})).waitFor();
  const cards=visible(page.locator('div[role="button"]')).filter({has:page.locator('button[aria-label="安装"],button[aria-label="已安装"]')});
  await cards.first().waitFor({timeout:20000});
  const names=(await cards.allTextContents()).map(text=>text.trim().slice(0,150));
  await fs.writeFile(path.join(dir,'技能市场候选.json'),JSON.stringify(names,null,2));
  assert(checks,'管理技能进入真实技能市场且展示候选',names.length>0);
  await capture('技能市场');
  const target=cards.filter({has:page.getByText('Office办公助手',{exact:true})});
  if(await target.count()!==1){log('技能市场安装待复核','当前已加载候选未找到原表Office办公助手；未选择无关技能替代');return [...gaps,'原表Office办公助手在当前已加载市场候选中未找到，安装及卸载分支待核对'];}
  const install=target.getByRole('button',{name:'安装',exact:true});
  if(!await install.count()){log('技能安装未执行','原表目标已安装，保留已有技能');return [...gaps,'原表目标技能已安装，未卸载用户已有技能；新增安装及清理分支未执行'];}
  const workspaceId=page.url().match(/\/workspace\/([^/]+)/)?.[1]||owned.url.match(/\/workspace\/([^/]+)/)[1];
  const {items}=await workspaces(page),projectDir=items.find(item=>item.id===workspaceId).path;
  resources={projectDir,targetName:'Office办公助手',installedBefore:await readInstalledSkills(page,projectDir),id:null,pending:true};
  await control.call('checkpoint',{skillResources:resources});
  let failure;
  try{
   await install.click();
   await target.getByRole('button',{name:'已安装',exact:true}).waitFor({timeout:60000});
   const added=(await readInstalledSkills(page,projectDir)).filter(id=>!resources.installedBefore.includes(id));
   if(added.length!==1)throw blocked('本轮市场安装未对应唯一新增技能，保留归属待复核');
   resources.id=added[0];resources.pending=false;await control.call('checkpoint',{skillResources:resources});
   assert(checks,'原表目标技能市场安装成功',true);await capture('技能市场安装完成');
   await initializeTestPage(page,{...config,log});await openPanel(page,'技能');
   await visible(page.locator('input[placeholder="输入名称搜索..."]')).fill('Office办公助手');
   const installedPicker=await waitForSkillPicker(page,{query:'Office办公助手'}),installedSkill=installedPicker.skills.find(skill=>skill.name===resources.id);
   assert(checks,'新安装技能可在输入区面板搜索到',Boolean(installedSkill)&&installedPicker.items.some(item=>item.id===installedSkill.id&&item.role==='checkbox'),{installedId:resources.id,candidates:installedPicker.items});await capture('安装技能回到输入区可见');
  }catch(error){failure=error;await capture('技能安装异常现场').catch(e=>log('技能异常截图失败',e.message));}
  finally{
   try{
    await releaseSkillResources(page,resources);await control.call('checkpoint',{skillResources:null});resources=null;
    assert(checks,'仅卸载本轮新安装的目标技能',true);
   }catch(error){log('技能收尾未完成',error.message);failure??=error;}
  }
  if(failure)throw failure;
  return gaps;
 }finally{if(!resources)await initializeTestPage(page,{...config,log});}
}

async function runExpert(page,config,checks,capture,log,control){
 const catalog=await readExpertCatalog(page),recentBefore=await page.evaluate(()=>localStorage.getItem('mobilework.recentExperts'));
 const resources={installedBefore:catalog.map(e=>e.id),recentBefore,touchedNames:['AIPPT专家','文档生成专家'],installTarget:'',installPending:false,workspaceId:page.url().match(/\/workspace\/([^/]+)/)[1],summonTarget:''};
 const checkpoint=()=>control.call('checkpoint',{expertResources:resources});
 const search=visible(page.locator('input[placeholder="搜索专家..."]'));
 const panel=search.locator('xpath=../..');
 const rows=panel.locator('button[class*="h-[42px]"]');
 const names=()=>rows.locator('span.truncate').allTextContents();
 const gaps=[],pending=new Set(['最近专家顺序及悬停','AIPPT搜索召唤及chip删除','文档生成专家市场安装','文档生成专家召唤及chip删除','点击空白关闭','新增专家与历史收尾']);let owned,failure;
 await checkpoint();
 const removeChip=async label=>{
  if(!(await draftOwnership(page,owned)).matches)throw blocked('专家chip操作前草稿与预登记内容不符，保留现场');
  assert(checks,'召唤专家产生本条输入区选择：'+label,owned.selection.length===1&&owned.selection[0].exit.includes(label),owned.selection);
  const item=page.locator('[data-composer-toolbar-item]').filter({visible:true}).filter({has:page.getByRole('button',{name:owned.selection[0].exit,exact:true,includeHidden:true})});
  await item.hover();const exit=item.getByRole('button',{name:owned.selection[0].exit,exact:true});
  assert(checks,'专家chip悬停显示删除入口：'+label,await exit.isVisible());
  await capture('专家已召唤-'+label);await exit.click();
  owned=await snapshotDraft(page);await control.checkpointDraft(owned);
  assert(checks,'专家chip删除后取消选择：'+label,owned.selection.length===0);
  assert(checks,'清理专家自动填充草稿：'+label,await clearOwnedDraft(page,owned,config));
  owned=await snapshotDraft(page);await control.checkpointDraft(owned);
 };
 try{
  await openPanel(page,'专家');assert(checks,'专家面板提供搜索框',await search.count()===1);
  const history=JSON.parse(recentBefore||'[]'),actual=await names();
  const expected=history.filter(e=>catalog.some(c=>[c.id,c.slug,c.assetId,c.primaryAgentId].some(id=>id&&[e.id,e.agentId,e.expertSlug,e.teamSlug,e.assetId].includes(id)))).slice(0,actual.length).map(e=>e.name);
  assert(checks,'最近专家顺序与真实历史一致',actual.length>0&&JSON.stringify(actual)===JSON.stringify(expected),{expected,actual});
  assert(checks,'专家面板提供召唤其他专家入口',await panel.getByRole('button',{name:'召唤其他专家',exact:true}).count()===1);
  const described=history.find(e=>actual.includes(e.name)&&e.description?.trim());
  if(!described)throw blocked('当前最近专家没有说明样例，无法验证悬停说明');
  await rows.filter({has:page.getByText(described.name,{exact:true})}).hover();
  const tip=visible(page.locator('[data-slot="tooltip-content"]'));await tip.waitFor();
  const description=await tip.innerText();assert(checks,'专家悬停显示真实说明',description.replace(/\s+/g,' ').includes(described.description.replace(/\s+/g,' ')),description);
  await capture('最近专家及悬停说明');
  pending.delete('最近专家顺序及悬停');
  const ppt=catalog.find(e=>e.name==='AIPPT专家');
  if(!ppt)throw blocked('原表AI PPT前置未满足：当前目录没有AIPPT专家；未改用无关专家');
  await search.fill('AI');const found=panel.getByRole('button').filter({has:page.getByText(ppt.name,{exact:true})});
  await found.waitFor();assert(checks,'搜索AI命中已安装AIPPT专家',await found.count()===1);
  await capture('搜索AI命中AIPPT专家');resources.summonTarget=ppt.name;await checkpoint();await found.click();await search.waitFor({state:'hidden'});
  const received=await snapshotDraft(page);await control.call('checkpoint',{draft:received,expertResources:{...resources,summonTarget:''}});owned=received;resources.summonTarget='';
  await removeChip(ppt.name);
  pending.delete('AIPPT搜索召唤及chip删除');
  await openPanel(page,'专家');await visible(page.getByText('Mobile熠动，Work智简',{exact:true})).first().click();
  await search.waitFor({state:'hidden'});assert(checks,'点击空白关闭专家面板',await search.count()===0);
  pending.delete('点击空白关闭');
  await openPanel(page,'专家');await panel.getByRole('button',{name:'召唤其他专家',exact:true}).click();
  await page.waitForURL(/#\/experts\/experts/);
  const marketSearch=visible(page.locator('input[placeholder="请输入关键词查询"]'));await marketSearch.fill('文档生成');
  const target=visible(page.locator('div[role="button"]')).filter({has:page.getByText('文档生成专家',{exact:true})});
  await target.waitFor({timeout:20000});assert(checks,'召唤其他专家进入市场并找到原表目标',await target.count()===1);
  await target.hover();await capture('文档生成专家市场入口');
  if(!catalog.some(e=>e.name==='文档生成专家')){
   resources.installTarget='文档生成专家';resources.installPending=true;await checkpoint();
   await target.getByRole('button',{name:'召唤',exact:true}).click();
   const installed=await waitForExpertInstall(page,resources);
   resources.installPending=false;await checkpoint();assert(checks,'原表文档生成专家真实安装到本机目录',installed.kind==='installed',{id:installed.id,name:installed.name});
   await capture('文档生成专家安装完成');
   pending.delete('文档生成专家市场安装');
  }else{gaps.push('文档生成专家原已安装，保留用户安装；新增安装分支未执行');}
  // Catalog registration can precede the completion of the first summon handler.
  // A busy summon button intentionally ignores clicks in the client.
  resources.summonTarget='文档生成专家';await checkpoint();
  await target.hover();await target.locator('button[aria-label="召唤"]:not([aria-busy="true"]):not([disabled])').click();
  await page.waitForURL(url=>url.hash==='#/session'||url.hash==='#/workspace/'+resources.workspaceId+'/session',{timeout:60000});
  if(await page.evaluate(()=>localStorage.getItem('openwork.react.newTaskDraftWorkspace'))!==resources.workspaceId)throw blocked('市场召唤返回的实际工作空间与登记不符，保留现场');
  const summoned=await snapshotDraft(page);await control.call('checkpoint',{draft:summoned,expertResources:{...resources,summonTarget:''}});owned=summoned;resources.summonTarget='';
  await removeChip('文档生成专家');
  pending.delete('文档生成专家召唤及chip删除');
  log('专家主流程检查完成','AI搜索、真实最近历史、悬停、市场安装召唤、chip删除、空白关闭');
 }catch(error){failure=error;await capture('专家异常现场').catch(e=>log('专家异常截图失败',e.message));}
 finally{
  if(await search.count())await closePanel(page);
  try{
   if(!resources.summonTarget&&owned&&(owned.text||owned.skills.length||owned.selection.length))assert(checks,'专家用例清理本条草稿',await clearOwnedDraft(page,owned,config));
   await releaseExpertResources(page,resources,{draft:owned,config,checkpoint});await control.call('checkpoint',{expertResources:null});
   assert(checks,'仅清理本轮新增专家并恢复召唤历史',true);
   pending.delete('新增专家与历史收尾');
   await initializeTestPage(page,{...config,log});
  }catch(error){log('专家收尾未完成',error.message);failure??=error;}
 }
 if(failure){failure.remainingSteps=[...pending];throw failure;}
 return gaps;
}

async function runTool(page,config,checks,capture,log,control,dir){
 await openPanel(page,'工具');
 const connects=visible(page.getByRole('button',{name:'连接',exact:true}));
 const count=await connects.count();assert(checks,'工具面板展示连接入口',count>0,count);
 const more=visible(page.getByRole('button',{name:'更多工具',exact:true}));assert(checks,'工具面板展示更多工具入口',await more.count()===1);
 const before=page.url();await capture('工具面板');
 const names=await visible(page.locator('div.flex.items-center')).filter({has:page.getByRole('button',{name:'连接',exact:true})}).allTextContents();
 await fs.writeFile(path.join(dir,'工具列表.json'),JSON.stringify(names,null,2));
 const modal=visible(page.locator('div[data-composer-toolbar-retain].fixed.inset-0'));
 const workspaceId=before.match(/\/workspace\/([^/]+)/)[1],{items}=await workspaces(page),projectDir=items.find(item=>item.id===workspaceId).path;
 const engine=await readEngineConnection(page),gaps=['未提供有效业务密钥，真实业务API鉴权成功分支未验证'];
 const pending=new Set(['百度地图密钥保存与连接、任务选择','TradingAgents投研无效密钥及终态恢复','本轮工具配置恢复','点击空白关闭工具面板']);
 const row=name=>visible(page.locator('span.truncate')).filter({hasText:new RegExp('^'+name+'$')}).locator('xpath=..');
 for(const [name,sample]of [['百度地图','1234'],['TradingAgents 投研','123456']]){
  let owned;
  try{owned=await prepareToolResources(page,{name,workspaceId,projectDir,sample});}
   catch(error){if(!error.blocked)throw error;gaps.push(error.message);log('工具前置未满足',error.message);continue;}
  await control.call('checkpoint',{toolResources:owned});
  let failure;
  try{
   if(!await row(name).count())await openPanel(page,'工具');
   await row(name).getByRole('button',{name:'连接',exact:true}).click();await modal.waitFor();
   assert(checks,'目标工具连接入口打开密钥设置：'+name,(await modal.innerText()).includes('密钥设置'));
   const loaded=await readOwnedToolState(page,owned);owned.id=loaded.id;await control.call('checkpoint',{toolResources:owned});
   assert(checks,'配置工具未离开本条任务：'+name,page.url()===before);
   const inputs=visible(modal.locator('input'));assert(checks,'密钥设置提供可编辑字段：'+name,await inputs.count()>0);
   for(const input of await inputs.all())await input.fill(sample);
   await capture('工具合成密钥设置-'+name);
   owned.connecting=true;await control.call('checkpoint',{toolResources:owned});
   const start=Date.now();await modal.getByRole('button',{name:'保存',exact:true}).click();await modal.waitFor({state:'hidden'});
   let state,observedConnecting=false;const timeline=[];
   while(Date.now()-start<195000){
    state=await readOwnedToolState(page,owned);
    timeline.push({at:new Date().toISOString(),...state});
    if(state.lifecycle==='configured'){
     if(!observedConnecting){
      observedConnecting=true;
      if(!await row(name).count())await openPanel(page,'工具');
      assert(checks,'连接中展示黄色状态及等待文案：'+name,await row(name).getByText('连接中…',{exact:true}).count()===1&&await row(name).locator('span.bg-\\[\\#FAAD14\\]').count()===1);
      await capture('工具连接中-'+name);
     }
    }
    if(['connected','disconnected'].includes(state.lifecycle))break;
    await page.waitForTimeout(1000);
   }
   await fs.writeFile(path.join(dir,'工具状态-'+name+'.json'),JSON.stringify(timeline,null,2));
   assert(checks,'合成密钥真实保存到工具注册表：'+name,state.secretSaved);
   if(!['connected','disconnected'].includes(state.lifecycle))throw blocked('工具连接超过产品三分钟等待仍未终结：'+name);
   owned.connecting=false;await control.call('checkpoint',{toolResources:owned});
   const statuses=await engineRequest(engine,'/mcp?directory='+encodeURIComponent(projectDir));
   const status=statuses[state.id]?.status;
   log('工具连接终态',name+'；页面='+state.lifecycle+'；引擎='+status+'；耗时='+Math.round((Date.now()-start)/1000)+'秒');
   if(!await row(name).count())await openPanel(page,'工具');
   if(state.lifecycle==='connected'){
    assert(checks,'页面连接成功与真实MCP握手一致：'+name,status==='connected'&&state.enabled,{status,enabled:state.enabled});
    const toggle=row(name).getByRole('switch');await toggle.waitFor();
    const checked=await toggle.getAttribute('aria-checked');await toggle.click();
    assert(checks,'工具任务选择开关切换：'+name,await toggle.getAttribute('aria-checked')!==checked);
    await capture('工具任务选择切换-'+name);await toggle.click();
    assert(checks,'工具任务选择恢复：'+name,await toggle.getAttribute('aria-checked')===checked);
    if(name==='TradingAgents 投研')gaps.push('TradingAgents合成无效密钥仍完成MCP握手；该握手不验证业务凭据，原表无效密钥必然连接失败的预期不成立');
   }else{
    assert(checks,'失败后恢复可再次连接且实际配置禁用：'+name,!state.enabled&&await row(name).getByRole('button',{name:'连接',exact:true}).isVisible(),{engineStatus:status,enabled:state.enabled});
    assert(checks,'失败恢复发生于产品等待上限内：'+name,Date.now()-start<195000);
   }
   await capture('工具连接终态-'+name);
   pending.delete(name==='百度地图'?'百度地图密钥保存与连接、任务选择':'TradingAgents投研无效密钥及终态恢复');
  }catch(error){failure=error;await capture('工具异常-'+name).catch(e=>log('工具异常截图失败',e.message));}
  finally{
   if(await modal.count())await modal.getByRole('button',{name:'取消',exact:true}).click();
   await closePanel(page);
   try{
    await releaseToolResources(page,owned);await control.call('checkpoint',{toolResources:null});
    assert(checks,'清理本轮合成配置并保留原有工具元数据：'+name,true);
    // Scoped-store IPC changes become visible after the product remounts.
    await page.reload();await initializeTestPage(page,{...config,log});
   }catch(error){log('工具收尾未完成',error.message);failure??=error;}
  }
  if(failure){failure.remainingSteps=[...pending,...gaps];throw failure;}
 }
 pending.delete('本轮工具配置恢复');
 await openPanel(page,'工具');await visible(page.getByText('Mobile熠动，Work智简',{exact:true})).first().click();
 assert(checks,'点击空白关闭工具面板',await more.count()===0);
 pending.delete('点击空白关闭工具面板');
 log('工具面板检查完成','列表、合成密钥保存、真实连接终态、任务选择及资源恢复');
 return [...pending,...gaps];
}

export async function runConfigCase(number){
 const definition=getClientCase(number),args=process.argv.slice(2);if(!definition.kind?.startsWith('config-'))throw Error('该入口只处理022～026配置用例');if(args.some(arg=>arg!=='--check'))throw Error('配置用例只支持 --check 或完整执行');
 const checkOnly=args.includes('--check'),config=normalizeConfig(JSON.parse(process.env.MW_TEST_CONFIG_JSON||'{}'));const started=new Date();const dir=await createRunDirectory(path.join(root,'runs'),definition.label+(checkOnly?'预检':''),started);const recorder=createEvidenceRecorder(dir),checks=[],events=[];let browser,page,result='BLOCKED',errorText='';
 let remainingSteps={22:[],23:['技能市场安装及本轮新增项卸载'],24:['最近专家顺序及悬停','专家市场安装召唤','专家chip删除及点击空白关闭'],25:['合成密钥保存及连接开关','错误密钥连接失败及状态恢复'],26:['全量解析与产物、引用开关及模块完整流程']}[number];
 const log=(step,detail='')=>{events.push({time:new Date().toISOString(),step,detail});console.log('['+beijingLogTime()+'] '+step+' '+detail);};const control=createTaskControl({log});const capture=step=>control?.withUI(page,'EVIDENCE',()=>recorder.capture(page,step));
 try{
  if(!control)throw blocked('请从18888控制台调度界面用例');browser=await connectClient('http://127.0.0.1:'+config.cdpPort,{timeout:15000});page=uniqueClientPage(browser);page.setDefaultTimeout(10000);await control.begin(page,{openComposer:!checkOnly,stepInterval:config.stepInterval,model:config.model});
  const {items}=await workspaces(page),currentId=page.url().match(/\/workspace\/([^/]+)/)?.[1];
  if(!items.some(item=>item.id===currentId))throw blocked('输入区引用的工作空间已不存在，请选择有效工作空间后重试；未继续配置检查');
  await capture('连接客户端');
  if(checkOnly){assert(checks,'目标配置入口存在',await exactToolbar(page,definition.button).count()===1);log('只读预检完成','未切换页面、清空草稿或点击配置控件');}
  else if(definition.kind==='config-mode')await runMode(page,config,checks,capture,log);else if(definition.kind==='config-skill')remainingSteps=await runSkill(page,config,checks,capture,log,control,dir);else if(definition.kind==='config-expert')remainingSteps=await runExpert(page,config,checks,capture,log,control);else if(definition.kind==='config-tool')remainingSteps=await runTool(page,config,checks,capture,log,control,dir);else{await runKnowledgeLifecycle(page,{config,checks,capture,log,dir,control});remainingSteps=[];}
  await capture('配置检查完成');result=checks.some(check=>!check.pass)?'FAIL':checkOnly?'CHECKED':remainingSteps.length?'REVIEW':'PASS';
  if(result==='FAIL')errorText='断言未通过：'+checks.filter(check=>!check.pass).map(check=>check.name).join('；');
 }catch(error){errorText=error.message;if(error.remainingSteps)remainingSteps=error.remainingSteps;result=error.blocked?'BLOCKED':'FAIL';log(result,errorText);if(page)await capture('异常现场').catch(()=>{});}
 finally{
  const scope=number===26?'本轮隔离知识库创建、原生目录选择、合成报告全量解析、真实Wiki产物、更新设置、首页引用开关及知识模块；不修改已有库。':number===25?'原表目标的工具配置、MCP连接终态、任务选择及本轮资源恢复；业务API鉴权与传输握手分开判定，未验证分支见remainingSteps。':'真实新建任务配置面板操作；未覆盖的原表步骤见remainingSteps，不代表整条原表验收完成。';
  const summary={result,caseId:definition.id,sheet:caseSheet,workbook:caseWorkbook,row:definition.row,title:definition.title,mode:checkOnly?'只读预检':'界面与本地接口执行',startedAt:started.toISOString(),endedAt:new Date().toISOString(),checks,events,evidence:recorder.evidence,error:errorText,scope,remainingSteps};
  await fs.writeFile(path.join(dir,'执行结果.json'),JSON.stringify(summary,null,2));await fs.writeFile(path.join(dir,'执行日志.txt'),events.map(e=>e.time+' '+e.step+' '+e.detail).join('\n')+'\n');
  const lines=['# '+definition.id+' 执行报告','','- 用例：'+definition.title,'- 原表：'+caseSheet+'，第'+definition.row+'行','- 结果：'+result,'- 范围：'+summary.scope,'- 错误或阻塞：'+(errorText||'无'),'','## 待补充或待验证','',...remainingSteps.map(step=>'- '+step),'','## 断言','',...checks.map(c=>'- '+(c.pass?'通过':'**失败**')+'：'+c.name),'','## 执行过程','',...events.map(e=>'- '+e.time+' '+e.step+' '+e.detail),'','## 过程截图','',...recorder.evidence.flatMap(e=>['### '+e.step,'','!['+e.step+']('+e.screenshot+')',''])];await fs.writeFile(path.join(dir,'执行报告.md'),lines.join('\n')+'\n');await control?.close(page).catch(e=>log('交还页面未完成',e.message));await browser?.close().catch(()=>{});console.log('报告：'+path.join(dir,'执行报告.md'));process.exitCode=['PASS','CHECKED','REVIEW'].includes(result)?0:result==='BLOCKED'?2:1;
 }
}
