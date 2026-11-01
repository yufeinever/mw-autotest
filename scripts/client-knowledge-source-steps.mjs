import fs from 'node:fs/promises';
import path from 'node:path';
import {randomInt,randomUUID} from 'node:crypto';
import {createManagedKnowledge} from './mobilework-knowledge-create.mjs';
import {parseOwnedKnowledge} from './mobilework-knowledge-parse.mjs';
import {reloadOwnedModule} from './mobilework-module-navigation.mjs';
import {finishKnowledgeGuide} from './mobilework-knowledge-guide.mjs';
import {flattenKnowledgeFiles,knowledgeStatusLabels,sourceToolbarControls,observeKnowledgeSourceRows,openKnowledgeReference,knowledgeReferenceRow,matchingKnowledgeNames,waitSourceFileSet,hasKnowledgeBudget} from './mobilework-knowledge-source-ui.mjs';
import {finalAssistantText} from './client-case-runner.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const save=(dir,name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
const sourceRoute=created=>'/knowledge/'+created.id+'/source';

async function returnToReferenceTask(page,resources){
 const owned=resources.moduleNavigation;
 if(!owned||new URL(page.url()).hash!==owned.targetHash)throw Error('返回引用面板前知识模块归属不匹配');
 await page.evaluate(url=>{location.hash=new URL(url).hash;},owned.originUrl);
 await page.waitForURL(owned.originUrl);
 await button(page,'运行任务').waitFor();
}

export async function openSources(page,created,context,{reload=false}={}){
 if(new URL(page.url()).hash!=='#/knowledge'){
  await button(page,'知识库').click();await button(page,'管理知识库').click();await page.waitForURL(url=>url.hash==='#/knowledge');
 }else if(reload||!await page.locator('[data-knowledge-guide="entry"]').isVisible())await reloadOwnedModule(page,context.resources);
 await button(page,created.name).click();await finishKnowledgeGuide(page,page.getByRole('tab',{name:'源文件',exact:true}),context);
}

async function prepareSourceFixture(created,number,dir,owner='林澈'){
 const code='晴川-'+randomUUID().slice(0,8),budget=randomInt(41000,59000);
 const file=path.join(created.source_dir[0],'晴川项目报告.md'),folder=path.join(created.source_dir[0],'海棠档案');
 await fs.mkdir(folder,{recursive:true});
 await fs.writeFile(file,'# 晴川项目验收报告\n\n本文件为自动化合成材料。\n\n项目代号：'+code+'。负责人：'+owner+'。预算：'+budget+'元。\n\n登录、搜索已验收，权限待复核，不得宣称全部通过。\n');
 await fs.writeFile(path.join(folder,'海棠会议纪要.md'),'# 海棠会议纪要\n\n本周复核权限证据，暂不安排正式上线。\n');
 if(number>=124)await fs.writeFile(path.join(created.source_dir[0],'暂不支持.bin'),'合成的未知类型文件，不执行其中内容。');
 if(number===124)await fs.writeFile(path.join(created.source_dir[0],'故意损坏的报告.docx'),'这不是Office压缩包，用于观察真实解析失败，不写入状态文件。');
 const fixture={code,budget,owner,file,folder};await save(dir,'本轮源材料事实.json',fixture);return fixture;
}

export async function refreshSources(page,call,created){
 await call('/knowledge/refresh',{id:created.id});
 const {buttons}=await sourceToolbarControls(page);await buttons.nth(6).click();
 return flattenKnowledgeFiles(await call(sourceRoute(created),{}));
}

async function sampleSourceStates(context,call,created,label,{transient=false}={}){
 const {page,dir,assert,capture}=context;
 const before=flattenKnowledgeFiles(await call(sourceRoute(created),{})),rows=await observeKnowledgeSourceRows(page,before),after=flattenKnowledgeFiles(await call(sourceRoute(created),{}));
 const stable=JSON.stringify(before)===JSON.stringify(after),observed=[];
 await save(dir,label+'.json',{before,rows,after,stable});
 if(stable){
  for(const file of before){
   const actual=rows.filter(row=>row.name===file.name);
   assert('源文件名称和类型图标真实展示：'+file.name,actual.length===1&&actual[0].icons>0,actual);
   const matches=actual.length===1&&knowledgeStatusLabels[file.status]?.some(text=>actual[0].text.includes(text));
   if(!transient)assert('源文件实际解析状态展示：'+file.name,matches,{status:file.status,actual});
   if(matches)observed.push(file.status);
  }
  await capture(label);
 }
 return observed;
}

async function checkToolbar(context){
 const {page,dir,assert,capture,remaining}=context;
 const {toolbar,buttons,labels}=await sourceToolbarControls(page);
 const rects=await buttons.evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}));
 await save(dir,'源文件完整工具栏.json',{labels,rects});
 assert('源文件七个操作图标完整且处于同一行',rects.every(r=>r.width>0&&r.height>0)&&Math.max(...rects.map(r=>r.y))-Math.min(...rects.map(r=>r.y))<12);
 await capture('源文件非搜索完整工具栏');remaining.delete('七图标实际布局');
 await buttons.nth(0).click();const search=toolbar.getByRole('textbox');await search.waitFor();
 assert('搜索激活后搜索框获得焦点',await search.evaluate(node=>document.activeElement===node));
 await search.fill('晴川');
 const activeButtons=toolbar.getByRole('button');
 assert('搜索态显示关闭筛选和更多而折叠其余五项',await activeButtons.count()===3&&await toolbar.locator('button[data-knowledge-guide="manage"]').count()===0&&await button(toolbar,labels[1]).count()===1);
 await activeButtons.last().click();const menu=page.getByRole('menu').filter({visible:true});await menu.waitFor();
 const items=await menu.getByRole('menuitem').allTextContents();await save(dir,'搜索态更多菜单实际项目.json',{expected:labels.slice(2),actual:items});
 assert('搜索态更多菜单包含原来折叠的全部五个操作',items.length===5&&labels.slice(2).every((name,i)=>items[i].trim()===name));
 await capture('搜索态更多菜单全部操作');await page.keyboard.press('Escape');remaining.delete('搜索焦点与更多五操作');
 await search.fill('');await activeButtons.first().click();await search.waitFor({state:'hidden'});
 const restored=await sourceToolbarControls(page);
 assert('退出搜索后完整工具栏恢复',JSON.stringify(restored.labels)===JSON.stringify(labels));
 await capture('搜索关闭后原工具栏恢复');remaining.delete('退出搜索恢复完整工具栏');
}

export async function checkSearchAndFilters(context,call,created,{searchOnly=false,keywords=['晴川','海棠档案','不存在-'+randomUUID().slice(0,8)],folderKeyword='海棠档案'}={}){
 const {page,dir,assert,capture,remaining}=context;
 const full=flattenKnowledgeFiles(await call(sourceRoute(created),{}));
 const {toolbar,buttons,labels}=await sourceToolbarControls(page);await buttons.first().click();const search=toolbar.getByRole('textbox');
 for(const keyword of keywords){
  const [response]=await Promise.all([
   page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===sourceRoute(created)&&r.request().postDataJSON().filename===keyword),
   search.fill(keyword)
  ]);
  const data=await response.json();assert('真实名称搜索请求成功',response.ok()&&data.success==='true');
  const files=flattenKnowledgeFiles(data.data),expected=matchingKnowledgeNames(full,keyword);
  await observeKnowledgeSourceRows(page,files,{autoExpand:false});
  await waitSourceFileSet(page,expected,full.map(file=>file.name));
  const shown=await page.locator('[data-knowledge-source-node] span[title]').filter({visible:true}).evaluateAll(nodes=>nodes.map(n=>n.title));
  await save(dir,'名称搜索-'+keyword+'.json',{keyword,expected,actual:files,shown});
  assert('名称模糊搜索包含匹配文件并排除其他文件',JSON.stringify(files.map(f=>f.name).sort())===JSON.stringify(expected)&&full.filter(f=>!expected.includes(f.name)).every(f=>!shown.includes(f.name)),{keyword,expected,shown});
  if(keyword===folderKeyword)assert('文件夹名称也可模糊命中',shown.includes(folderKeyword));
  await capture('源文件名称搜索-'+keyword);
 }
 await search.fill('');await toolbar.getByRole('button').first().click();await search.waitFor({state:'hidden'});remaining.delete('文件及文件夹名称搜索和排除');
 if(searchOnly)return;
 const radios=page.getByRole('menuitemradio').filter({visible:true});
 const openFilters=async()=>{
  if(!await radios.first().isVisible())await button(toolbar,labels[1]).click();
  await radios.first().waitFor();
 };
 for(const [statusIndex,status] of Object.keys(knowledgeStatusLabels).entries()){
  const before=flattenKnowledgeFiles(await call(sourceRoute(created),{}));
  await openFilters();
  const options=await radios.allTextContents();await save(dir,'状态筛选真实菜单-'+status+'.json',options);
  assert('实际状态筛选包含全部及当前七种状态',options.length===8,options);
  const candidate=radios.nth(statusIndex+1);
  const [response]=await Promise.all([
   page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===sourceRoute(created)&&r.request().postDataJSON().status===status),candidate.click()
  ]);
  const data=await response.json(),files=flattenKnowledgeFiles(data.data),expected=before.filter(f=>f.status===status);
  assert('真实解析状态筛选请求成功',response.ok()&&data.success==='true');await observeKnowledgeSourceRows(page,files,{autoExpand:false});
  await waitSourceFileSet(page,expected.map(file=>file.name),before.map(file=>file.name));
  const shown=await page.locator('[data-knowledge-source-node] span[title]').filter({visible:true}).evaluateAll(nodes=>nodes.map(n=>n.title));
  await save(dir,'状态筛选-'+status+'.json',{expected,actual:files,shown});
  assert('状态筛选命中和排除符合本轮真实状态',JSON.stringify(files.map(f=>f.path).sort())===JSON.stringify(expected.map(f=>f.path).sort())&&before.filter(f=>f.status!==status).every(f=>!shown.includes(f.name)),{status,expected:expected.length,actual:files.length});
  await capture('源文件实际状态筛选-'+status);
 }
 await openFilters();await page.getByRole('menuitemradio',{name:'全部',exact:true}).click();
 await page.keyboard.press('Escape');
 await observeKnowledgeSourceRows(page,full);remaining.delete('各状态真实筛选及清除');
}

async function referenceList(context,call,created){
 const {page,dir,resources,assert,capture,remaining}=context;
 await returnToReferenceTask(page,resources);const panel=await openKnowledgeReference(page);
 await knowledgeReferenceRow(panel,created.name).waitFor();
 const actual=await panel.locator('div.h-7').evaluateAll(nodes=>nodes.map(node=>({name:node.querySelector('span.truncate')?.textContent,icons:node.querySelectorAll('svg').length})).filter(item=>item.name));
 const expected=(await call('/knowledge/list')).filter(item=>item.open_ref);
 await save(dir,'任务知识库引用实际列表.json',{expected:expected.map(({id,name,status})=>({id,name,status})),actual});
 assert('引用列表完整展示开启引用的本地库名称及图标',JSON.stringify(actual.map(item=>item.name).sort())===JSON.stringify(expected.map(item=>item.name).sort())&&actual.every(item=>item.icons>0));
 const search=panel.getByRole('textbox');await search.fill(created.name.slice(-8));
 assert('知识库名称模糊搜索命中本轮库',await knowledgeReferenceRow(panel,created.name).count()===1);await capture('引用列表模糊搜索命中');
 await search.fill('无匹配-'+randomUUID());await panel.getByText('未找到匹配的知识库',{exact:true}).waitFor();
 assert('引用无匹配结果显示真实空状态',await panel.locator('[role="switch"]').count()===0);await capture('引用列表搜索空状态');
 await search.fill('');await button(page,'知识库').click();remaining.delete('引用完整列表图标模糊搜索及空状态');
}

async function referenceConversation(context,call,first,firstFixture){
 const {page,dir,resources,remaining,assert,capture,checkpointResources,send,getData}=context;
 const secondDir=path.join(dir,'第二知识库');
 const {created:second}=await createManagedKnowledge({...context,dir:secondDir},{resourceKey:'knowledgeSecondaryCreation'});
 const secondFixture=await prepareSourceFixture(second,123,secondDir,'周宁');await openSources(page,second,context);await refreshSources(page,call,second);
 let updatingObserved=false;
 const secondParsed=await parseOwnedKnowledge({...context,call,created:second,dir:secondDir,owned:resources.knowledgeSecondaryCreation,onProgress:async progress=>{
  if(updatingObserved||!progress.isActive)return;
  const status=await call('/knowledge/'+second.id);if(status.status!=='update')return;
  await returnToReferenceTask(page,resources);const panel=await openKnowledgeReference(page),row=knowledgeReferenceRow(panel,second.name);await row.waitFor();
  assert('真实更新中的知识库不能被选择',await row.getByRole('switch').count()===0&&(await row.innerText()).includes('更新中'));
  await capture('真实解析期间知识库引用禁用');updatingObserved=true;await button(page,'知识库').click();await openSources(page,second,context);
 }});
 assert('第二库真实Wiki保留本轮独立事实',secondParsed.text.includes(secondFixture.code)&&secondParsed.text.includes(secondFixture.owner)&&hasKnowledgeBudget(secondParsed.text,secondFixture.budget));
 await returnToReferenceTask(page,resources);let panel=await openKnowledgeReference(page);
 resources.knowledgeSelection={items:[first,second].map(({id,name})=>({id,name}))};await checkpointResources();
 for(const item of [first,second]){
  const row=knowledgeReferenceRow(panel,item.name),choice=row.getByRole('switch');await choice.waitFor();
  assert('新任务知识库引用默认关闭：'+item.name,await choice.getAttribute('aria-checked')==='false');await choice.click();
  assert('本轮可同时选择知识库：'+item.name,await choice.getAttribute('aria-checked')==='true');
 }
 await capture('本轮同时选中两库');await button(page,'知识库').click();remaining.delete('两库默认关闭与真实多选');
 await send('请仅依据当前选中的两份知识库“'+first.name+'”和“'+second.name+'”，分别列出晴川项目的项目代号、负责人和预算，并说明未完成的验收风险。不要编造缺失信息。');
 const firstData=getData(),answer=finalAssistantText(firstData),toolParts=firstData.messages.flatMap(message=>message.parts||[]).filter(part=>part.type==='tool'&&part.state?.status==='completed');
 for(const fixture of [firstFixture,secondFixture]){
  assert('实际引用正确提取本库隐藏合成事实：'+fixture.code,answer.includes(fixture.code)&&answer.includes(fixture.owner)&&hasKnowledgeBudget(answer,fixture.budget));
  assert('实际工具读取证据包含本库事实：'+fixture.code,toolParts.some(part=>{const output=JSON.stringify(part.state.output);return output.includes(fixture.code)&&hasKnowledgeBudget(output,fixture.budget);}));
 }
 panel=await openKnowledgeReference(page);
 for(const item of [first,second])assert('会话首轮结束仍保持本库引用：'+item.name,await knowledgeReferenceRow(panel,item.name).getByRole('switch').getAttribute('aria-checked')==='true');
 await capture('首轮完成两库引用仍保留');await button(page,'知识库').click();
 await send('请继续对照当前两份知识库，汇总两个项目的预算合计，并保留尚未验收的权限风险。',{continuing:true});
 const final=finalAssistantText(getData());assert('同Session续轮预算汇总及风险正确',hasKnowledgeBudget(final,firstFixture.budget+secondFixture.budget)&&/权限/.test(final)&&/待|未/.test(final));
 panel=await openKnowledgeReference(page);
 for(const item of [first,second])assert('续轮完成后引用仍常驻：'+item.name,await knowledgeReferenceRow(panel,item.name).getByRole('switch').getAttribute('aria-checked')==='true');
 await capture('同会话续轮知识库引用常驻');await button(page,'知识库').click();remaining.delete('两轮同Session实际引用及读取证据');
 if(updatingObserved)remaining.delete('真实更新中引用禁用');
 else throw review('两库真实引用已完成，但解析过快未取得更新中禁用现场；该分支仍待观察，不能判完整通过');
}

export async function runKnowledgeSourceSteps(context,{call,created}){
 const {number,page,dir,resources,remaining,assert,capture,checkpointResources}=context;
 if(number===122){await referenceList(context,call,created);return;}
 const fixture=await prepareSourceFixture(created,number,dir);await openSources(page,created,context);await refreshSources(page,call,created);
 const states=new Set(await sampleSourceStates(context,call,created,'本轮源文件初始状态'));remaining.delete('独立源材料及真实列表图标');
 if(number===125){await checkToolbar(context);return;}
 if(number===126){await checkSearchAndFilters(context,call,created);return;}
 let last='';
 const parsed=await parseOwnedKnowledge({...context,call,created,owned:resources.knowledgeCreation,onProgress:number===124?async progress=>{
  const files=flattenKnowledgeFiles(await call(sourceRoute(created),{})),signature=JSON.stringify(files.map(file=>[file.name,file.status]));
  if(signature!==last){last=signature;for(const status of await sampleSourceStates(context,call,created,'解析过程状态-'+Date.now(),{transient:true}))states.add(status);}
 }:undefined});
 assert('真实Wiki保留本轮合成事实',parsed.text.includes(fixture.code)&&parsed.text.includes(fixture.owner)&&hasKnowledgeBudget(parsed.text,fixture.budget));
 remaining.delete('真实全量解析与Wiki事实');
 if(number===123){await referenceConversation(context,call,created,fixture);return;}
 await refreshSources(page,call,created);
 for(const status of await sampleSourceStates(context,call,created,'解析终态源文件状态'))states.add(status);
 await fs.appendFile(fixture.file,'\n本地更新标记：'+randomUUID()+'。\n');await refreshSources(page,call,created);
 const updates=[],deadline=Date.now()+10000;
 do{
  const files=flattenKnowledgeFiles(await call(sourceRoute(created),{}));updates.push({at:new Date().toISOString(),files});
  if(files.some(file=>file.path===fixture.file&&file.status==='pending_update'))break;
  await page.waitForTimeout(250);
 }while(Date.now()<deadline);
 await save(dir,'源文件更新后台对账过程.json',updates);await refreshSources(page,call,created);
 for(const status of await sampleSourceStates(context,call,created,'解析后本地更新状态'))states.add(status);
 const required=['unparsed','success','fail','pending_update','updating','unable_parse'],missing=required.filter(status=>!states.has(status));
 await save(dir,'六类状态实际覆盖.json',{required,observed:[...states],missing});
 if(missing.length)throw review('实际源文件状态未完整触发：'+missing.join('、')+'；保留真实观察，不写入伪造状态补齐');
 remaining.delete('六类状态真实过程及本地待更新');await capture('六类源文档状态覆盖完成');await checkpointResources();
}
