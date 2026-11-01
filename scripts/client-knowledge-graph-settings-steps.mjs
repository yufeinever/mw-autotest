import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openSources,refreshSources,returnToReferenceTask} from './client-knowledge-source-steps.mjs';
import {parseOwnedKnowledge,completedKnowledgeParse} from './mobilework-knowledge-parse.mjs';
import {prepareKnowledgeReading,knowledgeFingerprint} from './mobilework-knowledge-reading.mjs';
import {openKnowledgeReference,knowledgeReferenceRow,hasKnowledgeBudget,flattenKnowledgeFiles} from './mobilework-knowledge-source-ui.mjs';
import {finalAssistantText} from './client-case-runner.mjs';
import {selectNativeFolder} from './mobilework-native-folder.mjs';
import {sameKnowledgePath} from './mobilework-knowledge-resources.mjs';
import {closeKnowledgeSettings,openKnowledgeSettings} from './mobilework-knowledge-api.mjs';
import {observeKnowledgeGraph,assessKnowledgeGraph,assessGraphHighlight,blankGraphPoint,relatedKnowledgeNodes,nextKnowledgeSchedule,knowledgeDirectoryManifest,relocatedKnowledgePath} from './mobilework-knowledge-graph-settings.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const blocked=message=>Object.assign(Error(message),{blocked:true});
const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const settingsOf=page=>page.getByRole('dialog',{name:'设置',exact:true}).filter({visible:true});
const save=(context,name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));

async function prepare(context,call,created,{parse=true}={}){
 const fixture=await prepareKnowledgeReading(created);await save(context,'本轮图谱设置合成源',fixture);
 await openSources(context.page,created,context);await refreshSources(context.page,call,created);
 if(parse)await parseOwnedKnowledge({...context,call,created,owned:context.resources.knowledgeCreation,timeoutMs:540000});
 await protect(context,fixture);
 context.remaining.delete(parse?'独立真实解析及材料保护':'独立未解析源及默认配置');
 return fixture;
}
async function protect(context,fixture){
 context.assert('本轮图谱及配置操作未改写原始源字节',(await Promise.all(fixture.inputs.map(async item=>knowledgeFingerprint(await fs.readFile(item.path))===item.sha256))).every(Boolean));
}
async function openSettings(context,created,options){
 await openSources(context.page,created,context,options);return openKnowledgeSettings(context.page,context);
}
async function saveSetting(context,created,action,label){
 const [response]=await Promise.all([context.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/knowledge/update_config'&&r.request().postDataJSON().id===created.id),action()]);
 const body=await response.json();await save(context,'设置保存-'+label,{request:response.request().postDataJSON(),httpStatus:response.status(),success:body.success});
 context.assert('真实UI设置请求保存成功：'+label,response.ok()&&body.success==='true');
}
async function setSwitch(context,created,name,value){
 const target=settingsOf(context.page).getByRole('switch',{name,exact:true});
 if((await target.getAttribute('aria-checked')==='true')!==value)await saveSetting(context,created,()=>target.click(),name+'-'+value);
 context.assert('设置开关实际回显：'+name,await target.getAttribute('aria-checked')===String(value));
}

async function graphReady(context,graph,condition=value=>value.ready){
 const deadline=Date.now()+15000;let observed;
 do{observed=await observeKnowledgeGraph(context.page,graph);if(condition(observed))return observed;await context.page.waitForTimeout(100);}while(Date.now()<deadline);
 await save(context,'图谱等待期限现场',observed);throw blocked('真实图谱布局或交互在观察期限内未完成，保留现场');
}
async function openGraph(context,call,created){
 await context.page.getByRole('tab',{name:'知识图谱',exact:true}).click();
 const graph=await call('/knowledge/'+created.id+'/graph');await save(context,'实际解析生成的图谱',graph);
 if(!graph.nodes.length||!graph.edges.length)throw review('本轮实际解析未生成可交互图谱，不预制实体或关系补足');
 await context.page.locator('aside.mw-knowledge-workspace canvas').filter({visible:true}).waitFor();
 const control=button(context.page,'全屏显示');await control.waitFor();
 const root=control.locator('xpath=../..'),token=randomUUID();await root.evaluate((node,token)=>node.setAttribute('data-mw-knowledge-graph-owner',token),token);
 context.resources.knowledgeCreation.graphToken=token;await context.checkpointResources();
 return {graph,root};
}
async function zoomTo(context,graph,target){
 const deadline=Date.now()+45000;let observed=await graphReady(context,graph);
 const increase=observed.zoom<target;
 while(increase?observed.zoom<target:observed.zoom>target){
  if(Date.now()>deadline)throw blocked('真实图谱按钮缩放未达到目标观察区间');
  const old=observed.zoom;await button(context.page,increase?'放大图谱':'缩小图谱').click();
  observed=await graphReady(context,graph,value=>Math.abs(value.zoom-old)>0.0001);
 }
 return observed;
}
async function visualization(context,call,created){
 const {graph}=await openGraph(context,call,created),samples=[];
 for(const [label,target] of [['显示名称',.65],['隐藏名称',.5]]){
  const observed=await zoomTo(context,graph,target),assessment=assessKnowledgeGraph(graph,observed);samples.push({label,observed,assessment});await save(context,'图谱可视化真实观察',samples);
  context.assert('图谱真实节点和边完整对应本库：'+label,assessment.sameIds);
  context.assert('节点尺寸按实际关联数分档且类型颜色正确：'+label,assessment.nodes.every(node=>node.size&&node.color),assessment.nodes);
  context.assert('强实线弱虚线与实际边类型一致：'+label,assessment.edges.every(edge=>edge.style),assessment.edges);
  context.assert('实际缩放阈值控制所有节点名称：'+label,assessment.nodes.every(node=>node.label),{zoom:observed.zoom,nodes:assessment.nodes});
  await context.capture('图谱规则-'+label);
 }
 context.remaining.delete('真实节点尺寸配色及边类型');context.remaining.delete('真实缩放阈值标签显隐');
 const missing=samples[0].assessment.missingBranches;if(missing.length)throw review('实际生成图谱未覆盖全部可视化分支：'+missing.join('、')+'；已观察部分保留，不制造缺来源节点或关系强度');
 context.remaining.delete('全部可视化分支真实覆盖');
}
const onCanvas=(observed,node)=>node.client[0]>observed.rect.x+20&&node.client[0]<observed.rect.x+observed.rect.width-90&&node.client[1]>observed.rect.y+20&&node.client[1]<observed.rect.y+observed.rect.height-150;
async function interactions(context,call,created){
 const {page,assert,capture,remaining}=context,{graph}=await openGraph(context,call,created),records=[],gaps=[];
 const observe=async label=>{const value=await graphReady(context,graph);records.push({label,value});await save(context,'图谱真实交互观察',records);return value;};
 let before=await observe('初始');
 for(const [name,factor] of [['放大图谱',1.05],['缩小图谱',1/1.05]]){
  const old=before.zoom;await button(page,name).click();before=await graphReady(context,graph,v=>Math.abs(v.zoom-old)>0.0001);
  assert('真实按钮缩放比例：'+name,Math.abs(before.zoom/old-factor)<.003,{before:old,after:before.zoom});
 }
 const blank=blankGraphPoint(before);await page.mouse.move(blank.x,blank.y);await page.mouse.wheel(0,-260);
 const enlarged=await graphReady(context,graph,v=>v.zoom>before.zoom);await page.mouse.wheel(0,260);
 const reduced=await graphReady(context,graph,v=>v.zoom<enlarged.zoom);
 assert('鼠标滚轮真实放大及缩小',enlarged.zoom>before.zoom&&reduced.zoom<enlarged.zoom);before=await observe('滚轮缩放');
 remaining.delete('真实按钮5%及滚轮缩放');
 const target=before.nodes.find(n=>onCanvas(before,n)&&relatedKnowledgeNodes(graph,n.id).size<graph.nodes.length)||before.nodes.find(n=>onCanvas(before,n));
 if(!target)throw review('真实图谱节点不在可操作视口内，未猜测坐标');
 const source=graph.nodes.find(n=>n.id===target.id);
 await page.mouse.move(...target.client);let hover=await graphReady(context,graph,v=>v.nodes.filter(n=>relatedKnowledgeNodes(graph,source.id).has(n.id)).every(n=>n.opacity===1)&&(!graph.nodes.some(n=>!relatedKnowledgeNodes(graph,source.id).has(n.id))||v.nodes.some(n=>n.opacity<1)));
 const highlighting=assessGraphHighlight(graph,hover,source.id);assert('悬停真实关联节点及连线保持高亮',highlighting.related&&highlighting.edges,highlighting);
 if(!highlighting.other)gaps.push('本轮图谱缺未关联节点，未验证置灰');await capture('图谱悬停关联与其他置灰');
 await page.mouse.down();try{
  await page.getByRole('heading',{name:source.label,exact:true}).filter({visible:true}).waitFor();await capture('节点真实长按详情');
 }finally{await page.mouse.up();}
 if(highlighting.other)remaining.delete('悬停长按及关联高亮置灰');
 // A selected node remains selected; use a real blank click before dragging.
 before=await observe('长按后');const blankAfter=blankGraphPoint(before);await page.mouse.click(blankAfter.x,blankAfter.y);before=await observe('取消选择');
 const selected=before.nodes.find(n=>n.id===source.id);await page.mouse.move(...selected.client);await page.mouse.down();
 try{await page.mouse.move(selected.client[0]+35,selected.client[1]+20,{steps:8});const during=await graphReady(context,graph,v=>v.nodes.find(n=>n.id===source.id).size===16);await save(context,'节点真实拖动中',during);await capture('节点拖动关联状态');}finally{await page.mouse.up();}
 const moved=await observe('节点移动后'),actual=moved.nodes.find(n=>n.id===source.id);
 assert('拖动真实节点改变其画布坐标',Math.hypot(actual.position[0]-selected.position[0],actual.position[1]-selected.position[1])>5);
 await page.mouse.move(...actual.client);await page.mouse.down();try{
  const during=await observe('第二次拖动起点');await page.mouse.move(actual.client[0]+12,actual.client[1]+8,{steps:4});
  const dragged=await graphReady(context,graph,v=>v.nodes.find(n=>n.id===source.id).size===16),highlight=assessGraphHighlight(graph,dragged,source.id);
  assert('真实拖动期间关联高亮、其余置灰',highlight.related&&highlight.edges&&(!highlighting.other||highlight.other),highlight);await save(context,'节点拖动真实高亮',{during,dragged,highlight});
 }finally{await page.mouse.up();}
 before=await observe('准备平移');const point=blankGraphPoint(before);await page.mouse.move(point.x,point.y);await page.mouse.down();try{await page.mouse.move(point.x+35,point.y+18,{steps:8});}finally{await page.mouse.up();}
 const panned=await graphReady(context,graph,v=>v.nodes.some(n=>Math.hypot(n.client[0]-before.nodes.find(b=>b.id===n.id).client[0],n.client[1]-before.nodes.find(b=>b.id===n.id).client[1])>10));
 assert('空白拖动画布整体平移且节点相对坐标保持',panned.nodes.every(n=>{const prev=before.nodes.find(b=>b.id===n.id);return Math.hypot(n.position[0]-prev.position[0],n.position[1]-prev.position[1])<1;}));remaining.delete('节点真实拖动及空白画布平移');
 await button(page,'全屏显示').click();await button(page,'退出全屏').waitFor();const fullscreen=await observe('全屏');
 assert('全屏图谱实际扩大',fullscreen.rect.width>panned.rect.width||fullscreen.rect.height>panned.rect.height);
 const fullNode=fullscreen.nodes.find(n=>n.id===source.id&&onCanvas(fullscreen,n))||fullscreen.nodes.find(n=>onCanvas(fullscreen,n));if(!fullNode)throw review('全屏真实图谱节点不在可操作视口');
 await page.mouse.click(...fullNode.client);await button(page,'全屏显示').waitFor();
 const label=graph.nodes.find(n=>n.id===fullNode.id).label,heading=page.getByRole('heading',{name:label,exact:true}).filter({visible:true});await heading.waitFor();
 const after=await observe('点击节点自动退出全屏');const headingRect=await heading.boundingBox();assert('点击节点退出全屏且右侧展示对应详情',await button(page,'退出全屏').count()===0&&!!headingRect&&headingRect.x>=after.rect.x+after.rect.width-2,{label,headingRect,graph:after.rect});
 await capture('图谱节点点击退出全屏并显示详情');remaining.delete('全屏点击节点退出及右侧详情');
 if(gaps.length)throw review(gaps.join('；'));
}

async function reference(context,call,created,fixture){
 let settings=await openSettings(context,created);await setSwitch(context,created,'引用',false);await closeKnowledgeSettings(context.page,{storageDir:created.storage_dir});
 await returnToReferenceTask(context.page,context.resources);let panel=await openKnowledgeReference(context.page),row=knowledgeReferenceRow(panel,created.name);
 const off=await call('/knowledge/'+created.id),switches=row.getByRole('switch');
 context.assert('关闭引用真实持久且任务列表不可选择该库',off.open_ref===false&&(await row.count()===0||await switches.count()===0||await switches.isDisabled()));await context.capture('关闭后引用列表不可选');await button(context.page,'知识库').click();
 settings=await openSettings(context,created);await setSwitch(context,created,'引用',true);await closeKnowledgeSettings(context.page,{storageDir:created.storage_dir});
 settings=await openSettings(context,created,{reload:true});context.assert('重载后引用开关真实保留',await settings.getByRole('switch',{name:'引用',exact:true}).getAttribute('aria-checked')==='true'&&(await call('/knowledge/'+created.id)).open_ref===true);await closeKnowledgeSettings(context.page,{storageDir:created.storage_dir});
 context.remaining.delete('引用关闭不可选及开启持久');await returnToReferenceTask(context.page,context.resources);panel=await openKnowledgeReference(context.page);row=knowledgeReferenceRow(panel,created.name);await row.getByRole('switch').waitFor();
 context.resources.knowledgeSelection={items:[{id:created.id,name:created.name}]};delete context.resources.moduleNavigation;await context.checkpointResources();
 context.assert('开启后本任务可选且初始未选择',await row.getByRole('switch').getAttribute('aria-checked')==='false');await row.getByRole('switch').click();await button(context.page,'知识库').click();
 await context.send('请仅依据选中的知识库“'+created.name+'”，列出晴川项目代号、负责人、预算和未完成的验收事项。');
 const data=context.getData(),answer=finalAssistantText(data),tools=data.messages.flatMap(m=>m.parts||[]).filter(p=>p.type==='tool'&&p.state?.status==='completed');
 context.assert('Agent真实引用取得未在问题中透露的随机事实',answer.includes(fixture.code)&&answer.includes(fixture.owner)&&hasKnowledgeBudget(answer,fixture.budget)&&/权限/.test(answer)&&/未|待/.test(answer));
 context.assert('实际完成工具输出包含本库随机事实',tools.some(p=>{const text=JSON.stringify(p.state.output);return text.includes(fixture.code)&&hasKnowledgeBudget(text,fixture.budget);}));await context.capture('引用开启后真实Agent取数');context.remaining.delete('开启后Agent实际引用及工具读取证据');
}

async function automaticUpdate(context,call,created,fixture){
 const {page,resources,assert,remaining}=context;let settings=await openSettings(context,created),initial=await call('/knowledge/'+created.id);
 assert('新库默认每日02:00且更新开关关闭',initial.update_time==='02:00'&&initial.open_update===false&&(await settings.innerText()).replaceAll('：',':').includes('02:00'));
 const schedule=nextKnowledgeSchedule();await settings.getByRole('button',{name:/每天|每日/}).click();const dialog=page.getByRole('dialog',{name:'定时',exact:true});await dialog.waitFor();
 resources.knowledgeCreation.dialogToken=randomUUID();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-knowledge-owner',token),resources.knowledgeCreation.dialogToken);await context.checkpointResources();
 await dialog.locator('input[type="time"]').fill(schedule.time);await saveSetting(context,created,()=>button(dialog,'确定').click(),'更新时间');await dialog.waitFor({state:'hidden'});delete resources.knowledgeCreation.dialogToken;
 resources.knowledgeCreation.scheduleTime=schedule.time;await context.checkpointResources();await setSwitch(context,created,'自动更新',true);await closeKnowledgeSettings(page,{storageDir:created.storage_dir});
 settings=await openSettings(context,created,{reload:true});const current=await call('/knowledge/'+created.id);assert('每日时刻和自动更新真实保存并重载保留',current.open_update===true&&current.update_time===schedule.time&&(await settings.innerText()).replaceAll('：',':').includes(schedule.time));
 await context.capture('真实每日自动更新时间');remaining.delete('默认02:00及每日时刻修改持久');await closeKnowledgeSettings(page,{storageDir:created.storage_dir});
 const baseline=await call('/knowledge/'+created.id+'/progress');await save(context,'真实定时基线',{schedule,baseline});
 if(Date.now()>=new Date(schedule.at).getTime()||baseline.isActive)throw review('定时基线未在到点前取得，不能将正在执行或旧终态冒充本轮定时触发');
 let observedActive=false,complete=false;const timeline=[],deadline=new Date(schedule.at).getTime()+540000;
 // No manual parsing is submitted here: only the product's real daily schedule can start this run.
 while(Date.now()<deadline){
  const progress=await call('/knowledge/'+created.id+'/progress');observedActive||=progress.isActive===true;timeline.push({at:new Date().toISOString(),...progress});await save(context,'真实到点更新观察',timeline);
  if(progress.pause)throw blocked('真实定时更新解析暂停，保留本轮注册及归属');
  if(Date.now()>=new Date(schedule.at).getTime()&&completedKnowledgeParse(progress,baseline,observedActive)){complete=true;break;}
  if(!progress.isActive&&/fail|error/i.test(progress.stage))throw Error('真实定时更新失败：'+progress.message);
  await page.waitForTimeout(1000);
 }
 if(!complete)throw review('每日配置已保存，但观察期限内未完成真实到点更新；不以配置成功替代自动执行');
 const files=flattenKnowledgeFiles(await call('/knowledge/'+created.id+'/source',{}));assert('真实到点更新完成且本轮两源解析成功',fixture.inputs.every(input=>files.some(file=>sameKnowledgePath(file.path,input.path)&&file.status==='success')));
 const wikis=(await knowledgeDirectoryManifest(path.join(created.wiki_dir,'wiki'))).filter(file=>file.type==='file'&&file.path.endsWith('.md'));let text='';for(const wiki of wikis)text+=await fs.readFile(path.join(created.wiki_dir,'wiki',wiki.path),'utf8');
 assert('定时解析真实生成Wiki且保留隐藏合成事实',text.includes(fixture.code)&&hasKnowledgeBudget(text,fixture.budget));await context.capture('真实到点自动解析终态');remaining.delete('真实到点更新及Wiki产物');
 settings=await openSettings(context,created);await setSwitch(context,created,'自动更新',false);await closeKnowledgeSettings(page,{storageDir:created.storage_dir});assert('本轮每日计划已关闭',(await call('/knowledge/'+created.id)).open_update===false);delete resources.knowledgeCreation.scheduleTime;await context.checkpointResources();remaining.delete('本轮更新计划公共收尾');
}

async function storagePath(context,call,created){
 const {page,resources,assert,remaining}=context,fixture=await prepare(context,call,created,{parse:false}),before=await knowledgeDirectoryManifest(created.storage_dir),settings=await openSettings(context,created);
 assert('设置显示真实Wiki目录',(await settings.innerText()).includes(created.wiki_dir));const target=path.join(context.dir,'本轮迁移后的存储');await fs.mkdir(target);assert('本轮迁移目标是独立空目录',(await fs.readdir(target)).length===0);
 resources.knowledgeCreation.storageMove={from:created.storage_dir,to:target,state:'picking'};await context.checkpointResources();
 const row=settings.locator('section').filter({has:page.getByText('wiki存储路径',{exact:true})});
 // Start listening before confirming the native dialog; it resolves through the renderer asynchronously.
 const [responseResult,selectionResult]=await Promise.allSettled([
  page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/knowledge/change_storage'&&r.request().postDataJSON().id===created.id,{timeout:60000}),
  selectNativeFolder(page,{folder:target,dir:context.dir,control:context.control,log:context.log,open:()=>button(row,'修改').click(),beforeConfirm:async()=>{resources.knowledgeCreation.storageMove.state='submitted';await context.checkpointResources();}})
 ]);
 if(selectionResult.status==='rejected')throw selectionResult.reason;
 if(responseResult.status==='rejected')throw responseResult.reason;
 const response=responseResult.value,body=await response.json();resources.knowledgeCreation.storageMove.state=response.ok()&&body.success==='true'?'completed':'rejected';await context.checkpointResources();
 await save(context,'真实原生存储迁移请求',{request:response.request().postDataJSON(),httpStatus:response.status(),success:body.success});assert('真实选择目录触发并完成本库迁移请求',response.ok()&&body.success==='true'&&sameKnowledgePath(response.request().postDataJSON().storage_dir,target));remaining.delete('原生目录真实识别及迁移请求');
 const after=await call('/knowledge/'+created.id),expectedSources=created.source_dir.map(value=>relocatedKnowledgePath(value,created.storage_dir,target));
 assert('迁移后同ID的存储Wiki及内部源路径一致',after.id===created.id&&sameKnowledgePath(after.storage_dir,target)&&sameKnowledgePath(after.wiki_dir,relocatedKnowledgePath(created.wiki_dir,created.storage_dir,target))&&JSON.stringify(after.source_dir)===JSON.stringify(expectedSources));
 const copied=await knowledgeDirectoryManifest(target),retained=await knowledgeDirectoryManifest(created.storage_dir);await save(context,'目录迁移完整文件及原位置保护',{before,copied,retained,after});assert('迁移完整复制所有真实目录及文件字节并保留旧目录',JSON.stringify(before)===JSON.stringify(copied)&&JSON.stringify(before)===JSON.stringify(retained));
 await page.waitForFunction(target=>[...document.querySelectorAll('[role="dialog"][aria-label="设置"] span')].some(node=>node.textContent===target),after.wiki_dir);await context.capture('原生迁移后真实路径回显');await closeKnowledgeSettings(page,{storageDir:target});await openSettings(context,after,{reload:true});const reloaded=await call('/knowledge/'+created.id);assert('重载后新Wiki路径保留',(await settingsOf(page).innerText()).includes(after.wiki_dir)&&sameKnowledgePath(reloaded.storage_dir,target));await closeKnowledgeSettings(page,{storageDir:target});remaining.delete('实际路径文件完整性及重载持久');await protect(context,fixture);
}

export async function runKnowledgeGraphSettingsSteps(context,{call,created}){
 if(context.number===141)return storagePath(context,call,created);
 const fixture=await prepare(context,call,created,{parse:context.number!==140});
 if(context.number===137)await visualization(context,call,created);
 if(context.number===138)await interactions(context,call,created);
 if(context.number===139)await reference(context,call,created,fixture);
 if(context.number===140)await automaticUpdate(context,call,created,fixture);
 await protect(context,fixture);
}
