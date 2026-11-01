import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {uploadTaskAttachment} from './mobilework-attachment-ui.mjs';
import {previewTaskFile,selectWorkbench} from './mobilework-task-ui.mjs';
import {readTodoPanel,selectTodoFilter,startTodoObservation,stopTodoObservation} from './mobilework-todo-ui.mjs';
import {inspectExplorer} from './mobilework-explorer.mjs';

const execFile=promisify(execFileCallback);
const blocked=message=>Object.assign(Error(message),{blocked:true});
const review=message=>Object.assign(Error(message),{review:true});
const normalize=text=>String(text).replace(/[*_`]/g,'').replace(/\s+/g,' ').trim();
const panelOf=page=>page.getByTestId('session-workbench-panel');
const statusLabels={pending:'待办',in_progress:'进行中',completed:'已完成',cancelled:'已完成'};
const todoCards=items=>items.map(item=>({content:item.content.trim(),status:statusLabels[item.status]}));
const sameCards=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

// Input/output contract uses Markdown headings; the graph is checked separately.
function headingTree(text){
 const result=[],stack=[];
 for(const line of text.split(/\r?\n/)){
  const match=line.match(/^(#{1,6})\s+(.+?)\s*#*$/);if(!match)continue;
  const level=match[1].length,title=normalize(match[2]);
  while(stack.length&&stack.at(-1).level>=level)stack.pop();
  const parent=stack.at(-1)?.title||null;result.push({level,title,parent});stack.push({level,title});
 }
 return result;
}

export async function runMindmapTodoSteps(context){
 const {number,page,config,control,dir,resources,remaining,outputs,assert,capture,log,send,checkpointResources,getData,getSessionId}=context;
 const finish=name=>remaining.delete(name),ui=action=>control.withUI(page,'INTERACTING',action);
 const save=(name,data)=>fs.writeFile(path.join(dir,name),JSON.stringify(data,null,2));
 async function archive(name){
  const text=await fs.readFile(path.join(control.directory,name),'utf8');
  await fs.writeFile(path.join(dir,name),text);outputs.push({name,path:name});return text;
 }
 if(number===67){
  const name='个人成长计划.markmap',branches=['学习成长','职业发展','健康习惯','复盘迭代'];
  await send('帮我生成个人成长计划的脑图，保存为“'+name+'”。使用Markdown标题语法：一个一级标题“个人成长计划”；四个二级标题分别为'+branches.join('、')+'；每个分支至少8个不同的三级行动节点，内容具体可执行。不要用图片代替源码。最后说明markmap使用Markdown语法、Markmap官网预览方式，以及转成Markdown后在XMind导入编辑的方式，并提供文件入口。');
  const text=await archive(name),tree=headingTree(text);await save('脑图源节点.json',tree);
  assert('真实脑图源码含根节点及四个主分支',tree.some(node=>node.level===1&&node.title==='个人成长计划')&&branches.every(branch=>tree.some(node=>node.level===2&&node.title===branch)),tree);
  assert('复杂脑图每分支含至少八个不同动作',branches.every(branch=>new Set(tree.filter(node=>node.level===3&&node.parent===branch).map(node=>node.title)).size>=8));finish('真实复杂markmap源码');
  await ui(async()=>{
   const panel=await previewTaskFile(page,config,name,capture),svg=panel.locator('svg.markmap');await svg.locator('g.markmap-node').first().waitFor();
   const rendered=await svg.evaluate(element=>({nodes:[...element.querySelectorAll('g.markmap-node')].map(node=>({depth:Number(node.dataset.depth),path:node.dataset.path,text:node.textContent.trim(),rect:node.getBoundingClientRect().toJSON()})),links:element.querySelectorAll('path.markmap-link').length,rect:element.getBoundingClientRect().toJSON()}));
   await save('脑图实际渲染节点.json',rendered);
   assert('脑图真实渲染节点及连线完整',rendered.nodes.length===tree.length&&rendered.links===tree.length-1&&rendered.rect.width>0&&rendered.rect.height>0,rendered);
   assert('脑图中文及父子层级与源文件一致',tree.every(node=>{
    const actual=rendered.nodes.find(item=>normalize(item.text)===node.title&&item.depth===node.level);
    const parent=node.parent&&rendered.nodes.find(item=>normalize(item.text)===node.parent);
    return actual&&!actual.text.includes('\uFFFD')&&(!parent||actual.path.startsWith(parent.path+'.'));
   }));finish('脑图中文节点与父子结构');await capture('复杂脑图真实渲染');
   const group=svg.locator(':scope > g').first(),before=await group.getAttribute('transform');
   await svg.hover();await page.mouse.wheel(0,-240);
   await page.waitForFunction(({selector,before})=>document.querySelector(selector)?.getAttribute('transform')!==before,{selector:'[data-testid="session-workbench-panel"] svg.markmap > g',before});
   const zoomed=await group.getAttribute('transform');assert('复杂脑图滚轮缩放真实生效',before!==zoomed,{before,zoomed});
   const box=await svg.boundingBox();await page.mouse.move(box.x+box.width*0.5,box.y+box.height*0.5);await page.mouse.down();
   try{await page.mouse.move(box.x+box.width*0.6,box.y+box.height*0.6,{steps:5});}finally{await page.mouse.up();}
   const after=await group.getAttribute('transform');assert('复杂脑图拖动查看真实生效',zoomed!==after&&await svg.locator('g.markmap-node').count()===tree.length,{zoomed,after});await capture('复杂脑图导航后');finish('复杂脑图滚轮与拖动查看');
  });
  const reply=getData().messages.filter(message=>message.info.role==='assistant').flatMap(message=>(message.parts||[]).filter(part=>part.type==='text').map(part=>part.text)).join('\n');
  assert('脑图回复包含Markdown与官网及XMind使用说明',/markdown/i.test(reply)&&/markmap(?:\.js\.org|.{0,20}官网)|官网.{0,20}markmap/i.test(reply)&&/xmind/i.test(reply)&&/导入|import/i.test(reply));finish('脑图使用说明语义');
 }else if(number===68){
  const source=fileURLToPath(new URL('./fixtures/mindmap/成长计划样本.markmap',import.meta.url)),input=await fs.readFile(source),name=path.basename(source),target=path.join(dir,name);
  await fs.writeFile(target,input);outputs.push({name:'输入-'+name,path:name});await save('脑图输入来源.json',{source:'scripts/fixtures/mindmap/'+name,sha256:createHash('sha256').update(input).digest('hex'),bytes:input.length});
  await ui(()=>uploadTaskAttachment(page,{file:target,name,resources,checkpointResources,capture}));finish('真实markmap上传');
  await send('帮我将上传的脑图文件转为Markdown，保存为“成长计划转换.md”。保持原文件全部标题、节点文字、父子层级及顺序，使用相同的Markdown标题层级，不加入新的节点。最后提供下载入口。');
  const text=await archive('成长计划转换.md'),original=headingTree(input.toString('utf8')),converted=headingTree(text);await save('脑图转换层级对照.json',{original,converted});
  assert('转为真实Markdown且全部节点父子顺序保留',original.length===21&&sameCards(original,converted));finish('Markdown真实产物及节点层级');
  await ui(async()=>{const panel=await previewTaskFile(page,config,'成长计划转换.md',capture),actual=await panel.innerText();assert('转换后Markdown实际预览含核心节点',['星桥成长计划','每周整理三条笔记','根据反馈调整目标'].every(fact=>actual.includes(fact)));await capture('转换后Markdown实际预览');});
  const info=await page.evaluate(()=>window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo')),base=new URL(info.baseUrl);
  if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw Error('客户端文件下载接口不是本机地址');
  const workspaceId=page.url().match(/#\/workspace\/([^/]+)\/session\//)[1];
  const response=await fetch(info.baseUrl.replace(/\/$/,'')+'/workspace/'+encodeURIComponent(workspaceId)+'/files/raw?path='+encodeURIComponent('成长计划转换.md')+'&sessionId='+encodeURIComponent(getSessionId()),{headers:{Authorization:'Bearer '+(info.ownerToken||info.clientToken)}});
  const downloaded=Buffer.from(await response.arrayBuffer());await save('Markdown实际下载.json',{source:'客户端本地文件下载接口',status:response.status,bytes:downloaded.length,sha256:createHash('sha256').update(downloaded).digest('hex')});
  await fs.mkdir(path.join(dir,'下载材料'));await fs.writeFile(path.join(dir,'下载材料','成长计划转换.md'),downloaded);outputs.push({name:'实际下载Markdown',path:'下载材料/成长计划转换.md'});
  assert('转换产物可实际下载且字节一致',response.ok&&downloaded.equals(Buffer.from(text)));finish('转换后文件真实下载');
  const script=fileURLToPath(new URL('./mobilework-xmind-installation.ps1',import.meta.url)),{stdout}=await execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,encoding:'utf8'}),installation=JSON.parse(stdout);
  await save('XMind安装前置检查.json',installation);
  if(!installation.available)throw blocked('已完成markmap转换、层级及下载核对；本机安装记录、PATH和Appx未发现XMind，原表XMind真实导入前置不满足。未用Markdown解析器冒充导入。');
  throw review('已发现XMind安装记录；当前没有已识别并接入的XMind本地导入控件，保留实际导入及节点还原检查，不冒充通过。');
 }else if(number===69){
  const name='预览目录定位.md',marker='本轮目录定位-'+path.basename(dir);
  await send('请在当前任务目录生成“'+name+'”，包含一级标题“目录定位核验”和独立段落“'+marker+'”。只生成此文件并提供入口。');
  const text=await archive(name);assert('真实交付物属于本Session且有唯一内容',text.includes(marker));finish('真实文件与实际预览');
  await ui(async()=>{
   const panel=await previewTaskFile(page,config,name,capture,[marker]),before=await inspectExplorer(control.directory);await save('目录定位前窗口.json',before);
   await panel.getByRole('button',{name:'在文件夹中显示',exact:true}).click();
   const deadline=Date.now()+15000;let actual;
   while(Date.now()<deadline){
    actual=await inspectExplorer(control.directory);
    const created=actual.windows.filter(item=>!before.windows.some(previous=>previous.hwnd===item.hwnd));
    if(!resources.explorerWindow&&created.length===1){resources.explorerWindow={path:control.directory,hwnd:created[0].hwnd};await checkpointResources();}
    if(actual.windows.some(item=>item.selected.some(file=>path.resolve(file).toLowerCase()===path.join(control.directory,name).toLowerCase())))break;
    await page.waitForTimeout(200);
   }
   await save('目录定位实际选择.json',actual);
   assert('Explorer实际打开目录并选中本轮文件',actual.windows.some(item=>item.selected.some(file=>path.resolve(file).toLowerCase()===path.join(control.directory,name).toLowerCase())),actual);finish('Explorer目录及真实文件选中');await capture('预览目录定位完成');
   const controls=await panel.locator('button').evaluateAll(elements=>elements.map(element=>({label:element.getAttribute('aria-label'),title:element.title,text:element.innerText})));await save('预览全屏入口观察.json',{controls,fullscreen:await page.evaluate(()=>Boolean(document.fullscreenElement))});
   const full=panel.getByRole('button',{name:/^(全屏|进入全屏|Full screen|Fullscreen)$/i}).filter({visible:true});
   if(await full.count()!==1)throw review('本轮文件及Explorer选中已核对；当前预览只暴露侧栏放大/还原，未找到原表真正全屏入口，全屏及退出恢复保留待复核。');
   resources.previewFullscreen={file:name};await checkpointResources();await full.click();
   await page.waitForFunction(()=>Boolean(document.fullscreenElement));await capture('真实全屏预览');
   const rect=await panel.evaluate(element=>({rect:element.getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight}));
   assert('全屏实际生效且预览覆盖当前视口',rect.rect.width>=rect.width-2&&rect.rect.height>=rect.height-2,rect);
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.fullscreenElement);delete resources.previewFullscreen;await checkpointResources();finish('真正全屏及退出恢复');
  });
 }else if(number===70||number===71){
  const owner=randomUUID(),engine=[],filterSamples=[],coveredFilters=new Set();let opened=false,lastEngine='';
  await ui(async()=>{resources.todoObservation=owner;await checkpointResources();await startTodoObservation(page,owner);});
  const observe=async({pending,final=false})=>{
   const todos=await control.get('/session/'+getSessionId()+'/todo'),signature=JSON.stringify(todos);
   if(signature!==lastEngine){engine.push({at:Date.now(),todos});lastEngine=signature;await save('待办引擎实际时间线.json',engine);}
   if(pending.length||!todos.length)return;
   await ui(async()=>{
    if(!opened){await selectWorkbench(page,config,'待办',capture);opened=true;resources.workbenchFilter={baseline:'全部'};await checkpointResources();}
    if(number!==71)return;
    for(const label of ['全部','待办','进行中','已完成']){
     if(coveredFilters.has(label)&&!final)continue;
     const before=await control.get('/session/'+getSessionId()+'/todo');
     await selectTodoFilter(page,label);const actual=await readTodoPanel(page),after=await control.get('/session/'+getSessionId()+'/todo');
     const stable=JSON.stringify(before)===JSON.stringify(after),selected=label==='全部'?before:before.filter(item=>statusLabels[item.status]===label),expected=todoCards(selected);
     filterSamples.push({at:Date.now(),label,stable,expected,actual});await save('待办实际筛选采样.json',filterSamples);
     if(stable){assert('待办筛选内容状态及顺序-'+label,sameCards(actual.cards,expected),{expected,actual});coveredFilters.add(label);await capture('待办真实筛选-'+label);}
    }
    if(coveredFilters.size===4)finish('四种真实状态筛选');
    await selectTodoFilter(page,'全部');
   });
  };
  let observation;
  try{
   await send('请生成一份虚构账号登录模块的多步骤测试用例文档，保存为“测试用例计划.md”。请使用产品的真实待办功能，将“梳理范围、设计场景、交叉复核、交付文档”作为四个业务阶段，按实际推进更新待办、进行中和已完成状态，不要在回复中假装更新，也不要提前把未完成阶段标为完成。需求：账号长度6至20，密码长度8至32，连续5次失败锁定15分钟。文档至少12条不同用例，以表格写出场景、输入、操作、预期；涵盖正常、长度边界、错误次数及锁定后恢复。先完成范围整理再设计场景，逐项实际写文件并复核，保留文件在本任务目录。',{waitOptions:{observe}});
   await observe({pending:[],final:true});
  }finally{
   await ui(async()=>{observation=await stopTodoObservation(page,owner);await save('待办界面实际时间线.json',observation);delete resources.todoObservation;await checkpointResources();});
  }
  const text=await archive('测试用例计划.md');
  assert('真实测试文档包含业务边界及至少十二条场景',['6','20','8','32','5','15'].every(value=>new RegExp('\\b'+value+'\\b').test(text))&&text.split('\n').filter(line=>/^\s*\|/.test(line)&&!/^\s*\|[\s:|\-]+\|\s*$/.test(line)).length>=13);finish('真实分阶段任务及用例文档');
  const tools=getData().messages.flatMap(message=>(message.parts||[]).filter(part=>part.type==='tool'&&part.state?.status==='completed'));
  const snapshots=[...engine.map(item=>item.todos),...tools.filter(part=>Array.isArray(part.state.input?.todos)).map(part=>part.state.input.todos)];
  await save('待办工具实际更新.json',tools.filter(part=>Array.isArray(part.state.input?.todos)).map(part=>({tool:part.tool,time:part.state.time,todos:part.state.input.todos})));
  const samples=(observation?.samples||[]).filter(sample=>sample.url.endsWith('/session/'+getSessionId())&&sample.filter==='全部'&&sample.cards.length);
  const matched=samples.filter(sample=>snapshots.some(items=>sameCards(sample.cards,todoCards(items))));
  assert('待办看板有与真实引擎对应的业务阶段',matched.some(sample=>sample.cards.length>=3),{engineSnapshots:snapshots.length,uiSamples:samples.length,matched:matched.length});finish('业务阶段真实看板内容');
  const states=new Set(matched.flatMap(sample=>sample.cards.map(card=>card.status)));
  if(['待办','进行中','已完成'].every(status=>states.has(status)))finish('三个状态过程与引擎对应');
  if(number===71){
   if(coveredFilters.size===4)finish('四种真实状态筛选');
   const final=await control.get('/session/'+getSessionId()+'/todo');
   await ui(async()=>{
    const actual=await readTodoPanel(page);await save('待办最终数量对照.json',{todos:final,actual});
    const expected=[['待办',final.filter(item=>item.status==='pending').length],['运行中',final.filter(item=>item.status==='in_progress').length],['已完成',final.filter(item=>['completed','cancelled'].includes(item.status)).length]];
    assert('顶部三种状态数量与真实待办相等',expected.every(([label,count])=>actual.counts.includes(label+' '+(count>99?'99+':count))),{expected,actual});finish('三状态汇总数量');
    assert('顶部显示原表要求的全部总数',actual.counts.includes('全部 '+final.length),{expected:final.length,counts:actual.counts});finish('全部总数展示');
   });
  }
 }
 if(remaining.size)throw review('已保存实际观察；以下原表要求仍未验证：'+[...remaining].join('、'));
}
