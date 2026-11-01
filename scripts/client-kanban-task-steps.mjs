import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepare,openCanvas} from './client-kanban-steps.mjs';
import {kanbanClient,openKanban,ownedCanvasWidgets} from './mobilework-kanban.mjs';

const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const review=message=>Object.assign(Error(message),{review:true});
const save=(context,name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));
const boardEditor=page=>page.getByPlaceholder('描述想要的小组件…',{exact:true}).filter({visible:true});
const frameOf=(page,id)=>page.locator('iframe[data-widget-id="'+id+'"]');
const taskTools=data=>data.messages.flatMap(message=>(message.parts||[]).filter(part=>part.type==='tool'&&part.state?.status==='completed'));

async function tag(context,locator,key,attribute){
 context.resources.kanban[key]=randomUUID();await locator.evaluate((node,{attribute,token})=>node.setAttribute(attribute,token),{attribute,token:context.resources.kanban[key]});await context.checkpointResources();
}
async function closeTagged(context,locator,key){
 await locator.press('Escape');await locator.waitFor({state:'hidden'});delete context.resources.kanban[key];await context.checkpointResources();
}

async function mailLayout(context,{call,before}){
 const {page}=context,matches=before.filter(item=>item.builtin&&item.title==='邮箱工作台');
 if(matches.length!==1)throw review('当前账号未唯一提供原表内置邮箱工作台，未创建伪内置看板');
 const detail=await call('/canvases/'+encodeURIComponent(matches[0].canvasId));await openCanvas(context,{...matches[0],placements:detail.placements});
 const headings=['优先级分布','邮件待办','每周邮件统计','待参加会议'];let target;
 for(const placement of detail.placements){
  const iframe=frameOf(page,placement.widgetId);await iframe.waitFor();
  const source=await call('/widgets/'+placement.widgetId+'/page');if(!headings.every(text=>source.html.includes(text)))continue;
  await iframe.contentFrame().locator('.kimi-section-title').filter({hasText:headings[0],visible:true}).first().waitFor();
  // Read section headings only. Mail subjects, bodies and recipients are not
  // copied into the structural observation.
  const found=await iframe.contentFrame().locator('.kimi-section-title').allTextContents();
  if(headings.every(text=>found.includes(text))){if(target)throw review('多个邮箱组件同时匹配，未猜测放大目标');target={iframe,widgetId:placement.widgetId};}
 }
 if(!target)throw review('邮箱组件实际正文未出现原表四区域，保留待核查，不把iframe外壳当布局通过');
 const boxes=[];
 for(const heading of headings){const node=target.iframe.contentFrame().locator('.kimi-section-title').filter({hasText:heading,visible:true}).first();await node.waitFor();const box=await node.boundingBox();context.assert('邮箱区域实际可见且尺寸有效：'+heading,!!box&&box.width>0&&box.height>0);boxes.push({heading,...box});}
 const overlaps=boxes.some((a,index)=>boxes.slice(index+1).some(b=>Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)+1&&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y)+1));
 context.assert('四个邮箱区域标题互不遮盖',!overlaps);await save(context,'邮箱四区域实际布局',{canvasId:detail.canvas.canvasId,widgetId:target.widgetId,boxes});await context.capture('邮箱看板四区域');context.remaining.delete('邮箱四区域真实正文及可见布局');
 const card=target.iframe.locator('xpath=../..'),original=await target.iframe.boundingBox();await button(card,'放大').click();
 const dialog=page.getByRole('dialog').filter({has:frameOf(page,target.widgetId)}).filter({visible:true});await dialog.waitFor();await tag(context,dialog,'dialogToken','data-mw-kanban-dialog');
 const enlarged=frameOf(dialog,target.widgetId);await enlarged.contentFrame().locator('.kimi-section-title').filter({hasText:headings[0],visible:true}).first().waitFor();
 for(const heading of headings)context.assert('放大弹框展示同一邮箱正文区域：'+heading,await enlarged.contentFrame().locator('.kimi-section-title').filter({hasText:heading,visible:true}).count()===1);
 const box=await dialog.boundingBox();context.assert('放大弹框具有实际可见内容尺寸',!!box&&box.width>0&&box.height>0&&!!original);await context.capture('邮箱看板真实放大弹框');await closeTagged(context,dialog,'dialogToken');
 context.assert('关闭放大后原邮箱组件仍展示',await target.iframe.isVisible());context.remaining.delete('邮箱放大弹框同组件正文及关闭恢复');
 await save(context,'147原表范围说明',{sourceTitle:'三屏布局、全屏与侧边栏控制验证',sourceSteps:'观察邮箱区域、点击邮箱组件放大',implemented:'原步骤四区域布局及放大弹框',unresolved:'标题另含三屏、全屏及侧边栏，原步骤没有明确切换或尺寸规则，保留待确认'});
 throw review('原步骤的邮箱布局及放大已检查；原标题另含三屏/全屏/侧边栏，缺具体切换和布局验收标准，保留待确认');
}

async function previewAndAdd(context,{call,canvas}){
 const {page,resources}=context;
 context.assert('当前自定义看板组件库入口唯一',await button(page,'组件库').count()===1);await button(page,'组件库').click();
 const library=page.getByRole('dialog',{name:'组件模板库',exact:true});await library.waitFor();await tag(context,library,'dialogToken','data-mw-kanban-dialog');
 context.assert('组件库没有额外分类页签',await library.getByRole('tab').count()===0);
 const titles=library.locator('span.relative.min-w-0.flex-1.truncate'),names=await titles.allTextContents();
 context.assert('组件库实际以多个名称卡片展示',names.length>0&&names.every(name=>name.trim()));await save(context,'组件库实际卡片名称',{names,tabCount:await library.getByRole('tab').count()});context.remaining.delete('组件库唯一入口及单页卡片结构');
 const card=library.getByText('番茄钟',{exact:true}).locator('xpath=../..');await button(card,'查看效果').click();
 const preview=page.getByRole('dialog',{name:'番茄钟',exact:true});await preview.waitFor();await tag(context,preview,'previewToken','data-mw-kanban-preview');
 const inner=preview.locator('iframe[title="番茄钟"]').contentFrame();
 const start=inner.getByRole('button',{name:/^(开始|继续)$/,exact:true}),pause=inner.getByRole('button',{name:'暂停',exact:true});
 await start.waitFor();await start.click();await pause.waitFor();await pause.click();await start.waitFor();
 context.assert('预览开始或继续与暂停真实改变按钮状态',await start.isVisible());await context.capture('番茄钟预览真实交互');
 context.assert('查看效果尚未向看板添加组件',(await call('/canvases/'+canvas.canvasId)).placements.length===0);await closeTagged(context,preview,'previewToken');context.remaining.delete('安全模板预览名称正文及实际交互');
 await button(card,'选择').click();context.assert('模板真实单选',await library.getByRole('checkbox').evaluateAll(nodes=>nodes.filter(node=>node.getAttribute('aria-checked')==='true').length)===1);
 resources.kanban.pendingAdd=true;await context.checkpointResources();await button(library,'添加到当前看板').click();await library.waitFor({state:'hidden'});delete resources.kanban.dialogToken;
 const detail=await call('/canvases/'+canvas.canvasId),ids=ownedCanvasWidgets(detail,(await call('/widgets')).items,resources.kanban);
 context.assert('当前看板只新增所选模板且无二次确认',ids.length===1&&detail.placements.length===1&&await page.getByRole('dialog').filter({visible:true}).count()===0);
 resources.kanban.pendingAdd=false;resources.kanban.widgetIds=ids;await context.checkpointResources();await frameOf(page,ids[0]).contentFrame().getByText('开始',{exact:true}).waitFor();
 await save(context,'模板预览与实际添加证据',{canvasId:canvas.canvasId,placements:detail.placements,widgetIds:ids,sourceDifference:'原表卡片直接添加；当前实际是先选择、再由弹框底部添加当前看板，无选择其他看板或二次确认'});await context.capture('预览后真实添加当前看板');context.remaining.delete('真实添加新组件placement及当前看板正文');
}

async function createViaUI(context){
 const {page,resources}=context,call=await kanbanClient(page),before=(await call('/canvases')).items,widgets=(await call('/widgets')).items;
 const title='MW-Autotest-Kanban-149-'+randomUUID().slice(0,8);
 resources.moduleNavigation={originUrl:page.url(),targetHash:'#/kanban'};resources.kanban={title,beforeIds:before.map(item=>item.canvasId),beforeWidgetIds:widgets.map(item=>item.widgetId),submitted:false,id:null,pendingAdd:false,removing:false,createUI:true,widgetTitle:title.replace('Kanban','Widget')};await context.checkpointResources();
 await openKanban(page);const addBoard=page.getByLabel('新建看板',{exact:true}).filter({visible:true});await addBoard.waitFor();resources.kanban.submitted=true;await context.checkpointResources();
 const [response]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/blueprint/canvases'),addBoard.click()]);
 context.assert('加号真实提交新建看板',response.ok());const canvas=await response.json();context.assert('新建看板ID不在基线且为真实空白板',!resources.kanban.beforeIds.includes(canvas.canvasId)&&canvas.title==='未命名看板'&&!canvas.builtin);resources.kanban.id=canvas.canvasId;await context.checkpointResources();
 await page.waitForURL(url=>url.hash==='#/kanban/'+canvas.canvasId);await page.getByText('看板是展示小组件的地方',{exact:true}).waitFor();await boardEditor(page).waitFor();
 const initial=await boardEditor(page).inputValue();context.assert('新建空板实际预填介绍澄清提示和目标canvasId',initial.includes(canvas.canvasId)&&initial.includes('先问我几个问题')&&initial.includes('小组件'));
 await save(context,'新建看板加号真实请求与默认提示',{canvasId:canvas.canvasId,title:canvas.title,prompt:initial,sourceDifference:'当前加号先创建空板；看板输入框发送后才自动进入新任务'});await context.capture('加号新建空板及默认提示');
 // Give the disposable board an exact identity using the actual rename UI.
 await button(button(page,'未命名看板').locator('..'),'看板操作').click();await page.getByRole('menuitem',{name:'重命名看板',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'重命名看板',exact:true});await dialog.waitFor();await tag(context,dialog,'dialogToken','data-mw-kanban-dialog');await dialog.getByPlaceholder('看板名称',{exact:true}).fill(title);await button(dialog,'保存').click();await dialog.waitFor({state:'hidden'});delete resources.kanban.dialogToken;await context.checkpointResources();
 context.assert('本轮空板经真实UI命名以保护资源归属',(await call('/canvases/'+canvas.canvasId)).canvas.title===title);context.remaining.delete('真实加号创建空板及默认澄清提示');return {call,canvas:{...canvas,title},before};
}

async function fillBoard(context,text){
 context.resources.kanban.draft=text;await context.checkpointResources();await boardEditor(context.page).fill(text);context.assert('看板输入框回读本轮完整需求',await boardEditor(context.page).inputValue()===text);
}
async function submitBoard(context,canvas,{empty=false}={}){
 const text=await boardEditor(context.page).inputValue(),originUrl=context.resources.moduleNavigation.originUrl;
 context.resources.kanban.task={originUrl,prompt:empty?text:text+'\n\n目标看板：「'+canvas.title+'」（canvasId：'+canvas.canvasId+'）。',submitted:false,sessionId:null};await context.checkpointResources();
 await context.sendKanbanTask();context.assert('产品看板发送创建独立Session并纳入统一调度',!!context.getSessionId());context.remaining.delete('看板发送自动任务及本轮Session交接');
}
async function boardAfterTask(context,canvas){
 await context.control.acquire(context.page,'EVIDENCE');const hash='#/kanban/'+canvas.canvasId;
 await context.page.evaluate(hash=>{location.hash=hash;},hash);await context.page.waitForURL(url=>url.hash===hash);await button(context.page,canvas.title).waitFor();
}
async function returnTask(context){const url=context.resources.url;await context.page.evaluate(url=>{location.hash=new URL(url).hash;},url);await context.page.waitForURL(url);}

async function aiCreate(context,fixture){
 const {canvas,call}=fixture,owned=context.resources.kanban,marker='计数-'+randomUUID().slice(0,8);
 const request='仅在这个测试看板（canvasId：'+canvas.canvasId+'）内创建一个纯本地计数小组件，组件标题为“'+owned.widgetTitle+'”，可见标题包含“'+marker+'”，初始数值0，有一个“增加”按钮，点击一次显示1。不要联网、不要读邮件、不要创建定时任务、绑定或submit事件，不修改其他看板。请先澄清需求，然后按确认结果实际生成HTML和placement。';
 await fillBoard(context,(await boardEditor(context.page).inputValue())+'\n\n'+request);await submitBoard(context,canvas,{empty:true});
 const first=context.getData(),tools=taskTools(first);await save(context,'看板创建首轮观察',{final:first.messages.filter(message=>message.info?.role==='assistant').flatMap(message=>(message.parts||[]).filter(part=>part.type==='text').map(part=>part.text)),completedToolNames:tools.map(part=>part.tool)});
 // Continue the same product-created Session with a concrete answer if the
 // first turn only asks clarifying questions. This is not a second board task.
 const detail=await call('/canvases/'+canvas.canvasId);
 if(!detail.placements.length){
  const trace=await context.saveTrace();if(trace.error)throw Error('澄清阶段日志Trace未归档：'+trace.error);
  const ask=first.messages.flatMap(message=>message.parts||[]).some(part=>part.type==='tool'&&/question/.test(part.tool))||first.messages.some(message=>message.info?.role==='assistant'&&(message.parts||[]).some(part=>part.type==='text'&&/[?？]|请.*(?:确认|选择)|需要.*(?:信息|需求)/.test(part.text||'')));
  context.assert('首轮确实提出需求澄清',ask);await context.send('需求已确认：'+request+' 请直接生成，不再等待确认。',{continuing:true});
 }
 const actual=await call('/canvases/'+canvas.canvasId),ids=ownedCanvasWidgets(actual,(await call('/widgets')).items,owned);context.assert('AI在目标看板真实生成一个新widget与placement',ids.length===1&&actual.placements.length===1);owned.widgetIds=ids;await context.checkpointResources();
 const html=await call('/widgets/'+ids[0]+'/page'),data=context.getData(),evidence=taskTools(data).map(part=>({tool:part.tool,input:part.state.input,output:part.state.output}));
 context.assert('本Session存在涉及真实组件的完成工具证据',evidence.some(item=>JSON.stringify(item).includes(ids[0])));context.assert('真实index.html包含本轮可见标记',html.html.includes(marker));await save(context,'AI新建看板组件结果',{canvas:actual,widgetId:ids[0],page:html,tools:evidence});
 await boardAfterTask(context,canvas);const frame=frameOf(context.page,ids[0]).contentFrame();await frame.getByText(marker,{exact:false}).waitFor();await frame.getByRole('button',{name:'增加',exact:true}).click();
 context.assert('AI生成的计数器实际点击后显示1',await frame.getByText('1',{exact:true}).isVisible());await context.capture('AI生成组件实际交互');await returnTask(context);context.remaining.delete('真实模型生成组件布局HTML及交互');
}

async function widgetFixture(context,{call,canvas}){
 const owned=context.resources.kanban;owned.widgetTitle=owned.title.replace('Kanban','Widget');owned.widgetPending=true;await context.checkpointResources();
 const widget=await call('/widgets',{method:'POST',body:{title:owned.widgetTitle,description:'本轮可丢弃的纯静态编辑测试fixture'}});context.assert('预存组件不在用户基线',!owned.beforeWidgetIds.includes(widget.widgetId)&&!widget.builtin&&!widget.events?.submit);owned.widgetIds=[widget.widgetId];await context.checkpointResources();
 const marker='保留-'+randomUUID().slice(0,8),before='修改前-'+randomUUID().slice(0,8),after='修改后-'+randomUUID().slice(0,8),html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>隔离看板编辑材料</title></head><body><h1 id="edit-target">'+before+'</h1><p id="keep-marker">'+marker+'</p></body></html>';
 await call('/widgets/'+widget.widgetId+'/page',{method:'PUT',body:{html}});await call('/canvases/'+canvas.canvasId+'/placements',{method:'POST',body:{widgetId:widget.widgetId,layout:{mode:'grid',x:0,y:0,w:8,h:10}}});owned.widgetPending=false;await context.checkpointResources();
 await button(context.page,'刷新').click();await frameOf(context.page,widget.widgetId).contentFrame().getByText(before,{exact:true}).waitFor();const baseline=await call('/widgets/'+widget.widgetId+'/page');await save(context,'预存静态组件材料',{widget,canvasId:canvas.canvasId,marker,before,after,page:baseline,origin:'本地正常API准备的预存fixture，不是AI执行结果'});context.remaining.delete('本轮既有静态组件及内容基线');return {widget,marker,before,after,baseline};
}

async function editResult(context,fixture,material){
 const {call,canvas}=fixture,{widget,marker,before,after,baseline}=material;
 const detail=await call('/canvases/'+canvas.canvasId),actual=await call('/widgets/'+widget.widgetId+'/page');
 context.assert('编辑保持同一个组件及唯一placement',detail.placements.length===1&&detail.placements[0].widgetId===widget.widgetId);context.assert('真实组件内容已改变而保留对照素材',actual.html!==baseline.html&&actual.html.includes(after)&&actual.html.includes(marker)&&!actual.html.includes(before));
 const evidence=taskTools(context.getData()).map(part=>({tool:part.tool,input:part.state.input,output:part.state.output}));context.assert('本Session有实际处理该widget或其index.html的工具证据',evidence.some(item=>JSON.stringify(item).includes(widget.widgetId)||JSON.stringify(item).includes(widget.workspaceRoot)));
 await save(context,'AI实际编辑组件产物',{canvas:detail,widgetId:widget.widgetId,before:baseline,after:actual,tools:evidence});await boardAfterTask(context,canvas);const frame=frameOf(context.page,widget.widgetId).contentFrame();await frame.getByText(after,{exact:true}).waitFor();context.assert('看板iframe实际显示修改结果且保留原对照',await frame.getByText(marker,{exact:true}).isVisible());await context.capture('看板实际展示AI编辑结果');await returnTask(context);context.remaining.delete('同组件真实HTML修改工具证据及看板回显');
}

async function annotate(context,material){
 const {page,resources}=context,editor=boardEditor(page),iframe=frameOf(page,material.widget.widgetId),pop=()=>page.locator('div.fixed').filter({has:page.getByPlaceholder('输入改动需求…',{exact:true})}).filter({visible:true});
 const note='只将此标题文字改成“'+material.after+'”，保留“'+material.marker+'”及其他元素。不联网、不创建任务绑定。',old=note+' 此为初稿。';
 const open=async()=>{await iframe.contentFrame().locator('#edit-target').click();const popup=pop();await popup.waitFor();await tag(context,popup,'annotationToken','data-mw-kanban-annotation');return popup;};
 let popup=await open();await popup.getByPlaceholder('输入改动需求…',{exact:true}).fill(old);resources.kanban.draft=(await editor.inputValue())+'\n'+old;await context.checkpointResources();await button(popup,'保存').click();await popup.waitFor({state:'hidden'});delete resources.kanban.annotationToken;resources.kanban.draft=await editor.inputValue();await context.checkpointResources();
 context.assert('批注保存真实生成目标widget及元素需求',resources.kanban.draft.includes(material.widget.widgetId)&&resources.kanban.draft.includes('edit-target')&&resources.kanban.draft.includes(old));await context.capture('组件批注保存及输入区同步');
 const pin=iframe.locator('xpath=../..').locator('button.absolute').filter({hasText:/^1$/});await pin.click();popup=pop();await popup.waitFor();await tag(context,popup,'annotationToken','data-mw-kanban-annotation');context.assert('再次点击批注回填原内容',await popup.getByPlaceholder('输入改动需求…',{exact:true}).inputValue()===old);
 await popup.getByPlaceholder('输入改动需求…',{exact:true}).fill(note);await button(popup,'保存').click();await popup.waitFor({state:'hidden'});delete resources.kanban.annotationToken;resources.kanban.draft=await editor.inputValue();await context.checkpointResources();context.assert('修改批注同步替换原草稿',resources.kanban.draft.includes(note)&&!resources.kanban.draft.includes('此为初稿'));
 await pin.click();popup=pop();await popup.waitFor();await tag(context,popup,'annotationToken','data-mw-kanban-annotation');await button(popup,'删除批注').click();await popup.waitFor({state:'hidden'});delete resources.kanban.annotationToken;resources.kanban.draft=await editor.inputValue();await context.checkpointResources();context.assert('删除批注同步移除需求与标记',!resources.kanban.draft.includes(note)&&await pin.count()===0);await context.capture('组件批注修改删除');
 popup=await open();await popup.getByPlaceholder('输入改动需求…',{exact:true}).fill(note);await button(popup,'保存').click();await popup.waitFor({state:'hidden'});delete resources.kanban.annotationToken;resources.kanban.draft=await editor.inputValue();await context.checkpointResources();context.remaining.delete('真实元素批注保存修改删除及输入区同步');
 await save(context,'151批注原步骤顺序差异',{source:'发送后再修改删除保存批注',actual:'产品发送会clearAnnotations；发送前先检查修改删除，再重新创建本轮批注并发送验证真实实现',note,widgetId:material.widget.widgetId});
}

export async function runKanbanTaskSteps(context){
 const fixture=context.number===149?await createViaUI(context):await prepare(context);
 if(context.number===147)return mailLayout(context,fixture);
 if(context.number===148)return previewAndAdd(context,fixture);
 if(context.number===149)return aiCreate(context,fixture);
 const material=await widgetFixture(context,fixture);await button(context.page,'编辑').click();await boardEditor(context.page).waitFor();context.remaining.delete('既有看板编辑模式及真实输入框');
 if(context.number===151)await annotate(context,material);
 else await fillBoard(context,'只编辑当前看板里widgetId为 '+material.widget.widgetId+' 的组件index.html，将h1#edit-target从“'+material.before+'”改成“'+material.after+'”。保留p#keep-marker的“'+material.marker+'”及布局、组件身份。不新增其他组件、不联网、不创建automation或binding。完成后验证组件。');
 await submitBoard(context,fixture.canvas);await editResult(context,fixture,material);
 if(context.number===151)throw review('批注保存、修改、删除及发送实施已检查；原表要求发送后继续修改原批注，与当前产品发送即清空的行为冲突，保留原顺序待确认');
}
