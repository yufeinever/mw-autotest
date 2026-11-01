import fs from 'node:fs/promises';
import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {finalAssistantText} from './client-case-runner.mjs';
import {attachmentRow} from './mobilework-composer-resources.mjs';
import {taskRow,openTaskMenu,selectWorkbench,openArtifactMenu,closeArtifactMenu,previewTaskFile} from './mobilework-task-ui.mjs';
import {uploadTaskAttachment} from './mobilework-attachment-ui.mjs';
import {inspectExplorer} from './mobilework-explorer.mjs';
import {snapshotDraft,inspectPageHandoff} from './mobilework-isolation.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const blocked=message=>Object.assign(Error(message),{blocked:true});
const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});
const messageText=message=>(message.parts||[]).filter(part=>part.type==='text').map(part=>part.text||'').join('\n');
const completedTools=data=>data.messages.flatMap(message=>(message.parts||[]).filter(part=>part.type==='tool'&&part.state?.status==='completed'));
const normalizeExcerpt=text=>text.normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu,'');

async function docxText(file){
 const contents=unzipSync(await fs.readFile(file)),xml=contents['word/document.xml'];
 if(!xml)throw Error('报告不是可读取的DOCX：'+path.basename(file));
 return [...strFromU8(xml).matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(match=>match[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')).join(' ');
}

export async function runTaskLifecycleSteps(context){
 const {number,definition,page,config,control,dir,resources,remaining,outputs,assert,capture,log,send,waitBusy,checkpointResources,getData,getSessionId,saveTrace}=context;
 const finish=step=>remaining.delete(step);
 const wait=async predicate=>{
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,200));}
  throw blocked('等待本条真实状态超时，保留已有证据');
 };
 const session=()=>control.get('/session/'+getSessionId());
 const rowFor=async()=>{const current=await session(),row=taskRow(page,current.title);await row.waitFor();if(await row.count()!==1)throw blocked('当前未唯一展示本轮历史任务');return {current,row};};
 const ui=action=>control.withUI(page,'INTERACTING',action);
 const nameOwnedTask=async()=>ui(async()=>{
  const title='MW-Autotest-'+getSessionId();
  const header=page.locator('div.group\\/session-title').filter({has:page.locator('h1')});
  await header.getByRole('button',{name:'重命名',exact:true}).click();
  const input=page.getByRole('textbox',{name:'会话名称',exact:true}).filter({visible:true});
  await input.fill(title);await input.press('Enter');await input.waitFor({state:'hidden'});
  await wait(async()=>(await session()).title===title);
 });

 if(number===32){
  await send('请为虚构星桥设备台账系统写一份简洁测试计划，覆盖新增、编辑、搜索，列出检查目标。只回复文字，不生成文件。');
  assert('首轮计划包含实际测试目标',['新增','编辑','搜索'].every(word=>finalAssistantText(getData()).includes(word)));finish('本轮测试计划历史');
  const name='星桥补充材料-'+path.basename(dir)+'.txt',input=path.join(dir,'输入材料',name);
  const facts='本文件是自动化测试合成输入。星桥设备台账项目：样本设备47台，盘点通过43台，异常4台；负责人许棠，复核截止2026年11月9日。异常分为资产编号重复2台、使用人缺失2台。';
  await fs.mkdir(path.dirname(input),{recursive:true});await fs.writeFile(input,facts,'utf8');
  await control.acquire(page,'INTERACTING');
  await uploadTaskAttachment(page,{file:input,name,resources,checkpointResources,capture});
  await attachmentRow(page,name).waitFor();await capture('同一会话上传合成材料');assert('第二轮附件标签显示真实文件',await attachmentRow(page,name).count()===1);finish('会话中上传真实合成文档');
  const boundary=await send('请读取刚上传文件，结合其内容补充异常数据测试点，并给出样本数、通过数、异常数、负责人和截止日期。不要联网。',{continuing:true});
  const messages=getData().messages,turn=messages.slice(messages.findIndex(message=>message.info?.id===boundary)+1);
  const users=turn.filter(message=>message.info?.role==='user'),relative=path.join('.mobilework','inbox',getSessionId(),name),expected=path.resolve(control.directory,relative);
  const references=users.flatMap(message=>[...messageText(message).matchAll(/\[附件文件:([^\]\r\n]+)\]/g)].map(match=>({messageId:message.info.id,path:match[1],resolvedPath:path.resolve(control.directory,match[1])})));
  const actualReferences=references.filter(item=>item.resolvedPath.toLowerCase()===expected.toLowerCase());
  const inputPaths=[relative,expected].map(value=>value.replaceAll('\\','/').replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const inputPath=new RegExp('(?:^|[\\s"\\x27\\x60(])(?:'+inputPaths.join('|')+')(?=$|[\\s"\\x27\\x60);])','i');
  const toolEvidence=completedTools({messages:turn}).map(part=>({tool:part.tool,input:part.state.input,output:part.state.output,pathMatches:Object.values(part.state.input||{}).some(value=>typeof value==='string'&&inputPath.test(value.replaceAll('\\','/'))),contentMatches:String(typeof part.state.output==='string'?part.state.output:JSON.stringify(part.state.output)).includes(facts)}));
  const extracted=users.some(message=>(message.parts||[]).some(part=>part.type==='text'&&part.text.includes(facts)));
  await fs.writeFile(path.join(dir,'会话附件提交与读取依据.json'),JSON.stringify({sessionId:getSessionId(),boundary,expectedPath:expected,references,userMessages:users.map(message=>({id:message.info.id,parts:message.parts})),toolEvidence,extracted},null,2));
  assert('附件作为本Session第二轮真实上传引用提交',actualReferences.length===1,{expectedPath:expected,references});
  const output=finalAssistantText(getData());
  assert('回复保留文件事实并提供异常测试点',['47','43','4','许棠','重复','缺失'].every(word=>output.includes(word))&&/11.{0,3}9|2026-11-09/.test(output));
  const read=toolEvidence.some(item=>item.pathMatches&&item.contentMatches);
  if(!read&&!extracted)throw review('最终回复吻合附件事实，但未取得附件解析文本或完成读取工具输出，不能完整验收文件解析');
  assert('本Session取得本轮上传材料的实际读取依据',read||extracted,{completedToolRead:read,parsedUserText:extracted});
  await ui(async()=>{resources.attachments=[];await checkpointResources();});finish('附件发送及内容读取');
 }else if(number===33){
  await send('计算虚构台账的记录总量：甲组18条、乙组27条。回复结果与计算过程，不调用外部服务。');
  const first=getData(),firstUser=first.messages.find(message=>message.info?.role==='user');
  assert('本轮历史任务真实完成',finalAssistantText(first).includes('45'));
  await nameOwnedTask();
  await ui(async()=>{const {row}=await rowFor();await row.locator('button,a[data-slot="sidebar-menu-sub-button"]').first().click();await page.locator('[data-message-id="'+firstUser.info.id+'"]').waitFor();await capture('历史任务可打开');});finish('本轮已完成历史可打开');
  await send('请为虚构设备盘点写一份详细测试计划，按录入、校验、查询、导出四阶段逐项分析，每阶段提供十个不同边界场景及预期结果。只输出文字。',{continuing:true,wait:false});
  await waitBusy();
  await ui(async()=>{const {row}=await rowFor();await row.getByRole('img',{name:'执行中',exact:true}).waitFor();await capture('历史任务执行中');if((await control.get('/session/status'))[getSessionId()]?.type!=='busy')throw review('点击停止前本轮已经结束，未把正常完成当作停止成功');await button(page,'停止').click();});
  await wait(async()=>(await control.get('/session/status'))[getSessionId()]?.type!=='busy');
  const stopped=await control.readLog();await fs.writeFile(path.join(dir,'停止后会话快照.json'),JSON.stringify(stopped,null,2));
  const interrupted=stopped.messages.some(message=>/abort|cancel|interrupt/i.test(JSON.stringify(message.info?.error||'')));
  assert('用户停止后本轮引擎确认为非busy',(await control.get('/session/status'))[getSessionId()]?.type!=='busy');finish('进行中状态与用户停止');
  await send('继续此会话，只计算甲组18条和乙组27条的总数，并用一句话给出结果，无需续写长计划。',{continuing:true});
  assert('同一Session恢复执行完成',getData().messages.some(message=>message.info?.role==='user'&&messageText(message).includes('继续此会话'))&&finalAssistantText(getData()).includes('45'));finish('同一任务恢复执行');
  log('覆盖边界','已完成/执行中/停止后续轮为本条目标；错误及待确认需要真实触发，未伪造这两种状态');
  if(!interrupted)throw review('停止按钮已点击且引擎空闲，续轮已完成，但缺少真实中止事件证据，不能把恰好完成当作完整停止验收');
 }else if(number===34){
  const marker='MW-Autotest-'+path.basename(dir);
  await send('本次为合成任务 '+marker+'。请在当前任务目录生成“任务管理样例.txt”，内容为“'+marker+'”。只生成这个文件。');
  const file=path.join(control.directory,'任务管理样例.txt');assert('本轮独立任务目录及文件可核对',(await fs.readFile(file,'utf8')).includes(marker));
  await nameOwnedTask();
  await control.acquire(page,'INTERACTING');let {current,row}=await rowFor();
  resources.taskPin={title:current.title,baseline:await row.locator('[data-pinned-session="true"]').count()===1};await checkpointResources();
  if(resources.taskPin.baseline)throw review('本轮新任务已被外部置顶，保留状态，不覆盖用户操作');
  await openTaskMenu(page,current.title);await page.getByRole('menuitem',{name:'置顶',exact:true}).click();
  await row.locator('[data-pinned-session="true"]').waitFor();await capture('本轮任务已置顶');assert('置顶后本轮行真实标记置顶',await row.locator('[data-pinned-session="true"]').count()===1);
  const pinnedTitles=await page.locator('[data-pinned-session="true"]').allTextContents();assert('本轮任务位于置顶任务区',pinnedTitles.some(title=>title.includes(current.title)));
  await openTaskMenu(page,current.title);await page.getByRole('menuitem',{name:'取消置顶',exact:true}).click();await row.locator('[data-pinned-session="true"]').waitFor({state:'hidden'});
  delete resources.taskPin;await checkpointResources();finish('本轮任务置顶与取消');
  const renamed=current.title+'-重命名';await openTaskMenu(page,current.title);await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
  const input=page.getByRole('textbox',{name:'会话名称',exact:true}).filter({visible:true});await input.fill(renamed);await input.press('Enter');await input.waitFor({state:'hidden'});
  await wait(async()=>(await session()).title===renamed);row=taskRow(page,renamed);await row.waitFor();assert('真实Session及历史列表已持久化新名称',(await session()).title===renamed);await capture('本轮任务重命名');finish('重命名持久化');
  const baseline=await inspectExplorer(control.directory,{reveal:true});
  await fs.writeFile(path.join(dir,'任务文件夹Explorer窗口基线.json'),JSON.stringify(baseline,null,2));
  await openTaskMenu(page,renamed);await page.getByRole('menuitem',{name:'打开文件夹',exact:true}).click();
  let opened;await wait(async()=>{opened=await inspectExplorer(control.directory,{reveal:true});return opened.windows.some(item=>item.targetVisible);});
  await fs.writeFile(path.join(dir,'任务文件夹实际窗口.json'),JSON.stringify(opened,null,2));
  const added=opened.windows.filter(item=>item.targetVisible&&!baseline.windows.some(before=>before.hwnd===item.hwnd));
  if(added.length===1){resources.explorerWindow={path:control.directory,hwnd:added[0].hwnd,reveal:true};await checkpointResources();}
  assert('Windows实际打开或定位本Session任务文件夹',opened.windows.some(item=>item.targetVisible),opened);finish('实际任务文件夹可打开');
  // Deletion is the business operation; preserve logs first because the engine
  // correctly returns 404 afterwards. Never delete historical user sessions.
  const trace=await saveTrace();
  if(trace.error)throw blocked('删除前会话日志/Trace未保存，已保留本轮Session：'+trace.error);
  await openTaskMenu(page,renamed);await page.getByRole('menuitem',{name:'删除',exact:true}).click();
  const dialog=page.getByRole('dialog').filter({visible:true});await dialog.waitFor();
  assert('删除确认对应本轮名称',(await dialog.innerText()).includes(renamed));await capture('本轮任务删除确认');await dialog.getByRole('button',{name:'删除',exact:true}).click();await dialog.waitFor({state:'hidden'});await taskRow(page,renamed).waitFor({state:'hidden'});
  const response=await fetch(control.connection.baseUrl.replace(/\/$/,'')+'/session/'+getSessionId()+'?directory='+encodeURIComponent(control.directory),{headers:{Authorization:'Basic '+btoa(control.connection.opencodeUsername+':'+control.connection.opencodePassword)},signal:AbortSignal.timeout(15000)});
  assert('本轮任务已从真实引擎移除',response.status===404);assert('删除Session后保留本轮本机产物',(await fs.readFile(file,'utf8')).includes(marker));
  const home=control.sessionUrl.slice(0,-('/'+getSessionId()).length);
  await page.waitForURL(home);
  const handoff=await inspectPageHandoff(page);
  if(!handoff.ready)throw blocked('删除后首页尚未交接：'+handoff.reason);
  await context.checkpointPage(await snapshotDraft(page));
  // The archived Session stays on the job; the active page is now its home.
  control.sessionId=null;
  await control.release(page,'VERIFYING');finish('删除确认与本轮任务移除');
 }else if(number===35||number===36){
  const sales=number===35,intermediate=sales?'明细.csv':'网页摘录.md',report=sales?'验收销售报告.docx':'网页摘要.docx';
  const seen={todosDuring:false,intermediateBeforeFinal:false,browser:false,intermediatePanelOpened:false,intermediateEntryMissing:false};
  const observe=async({states,pending})=>{
   if(pending.length||states[getSessionId()]?.type!=='busy')return;
   const todos=await control.get('/session/'+getSessionId()+'/todo');
   if(!seen.todosDuring&&todos.some(item=>item.status==='in_progress')){
    await fs.writeFile(path.join(dir,'执行中待办.json'),JSON.stringify(todos,null,2));
    await ui(async()=>{await selectWorkbench(page,config,'待办',capture);assert('执行中真实待办与界面节点一致',await page.getByText(todos.find(item=>item.status==='in_progress').content,{exact:true}).count()>0);});seen.todosDuring=true;
   }
   if(sales&&!seen.intermediateBeforeFinal){
    const files=await fs.readdir(control.directory);
    if(files.includes(intermediate)&&!files.includes(report)){
     await ui(async()=>{
      if(!seen.intermediatePanelOpened){await selectWorkbench(page,config,'产物',capture);seen.intermediatePanelOpened=true;}
      const trigger=page.getByTestId('session-workbench-panel').getByRole('button',{name:'产物',exact:true}).filter({visible:true});
      let listed=false;
      if(await trigger.count()){
       const menu=await openArtifactMenu(page);
       try{listed=await menu.getByRole('menuitem',{name:intermediate,exact:true}).filter({visible:true}).count()===1;}
       finally{await closeArtifactMenu(page);}
      }
      if(!listed){
       if(!seen.intermediateEntryMissing){
        await fs.writeFile(path.join(dir,'中间文件尚未登记预览.json'),JSON.stringify({sessionId:getSessionId(),file:intermediate,diskPresent:true,artifactListed:false,time:new Date().toISOString()},null,2));
        await capture('中间CSV已落盘但产物尚未登记');seen.intermediateEntryMissing=true;
        log('中间文件预览待观察','本轮CSV已落盘，但客户端未提供该产物入口，继续处理模型及审批');
       }
       return;
      }
      if((await control.get('/session/status'))[getSessionId()]?.type!=='busy'||(await fs.readdir(control.directory)).includes(report))return;
      await previewTaskFile(page,config,intermediate,capture,['甲','乙']);
      seen.intermediateBeforeFinal=!(await fs.readdir(control.directory)).includes(report);
     });
    }
   }
  };
  const prompt=sales?'请按“整理数据、计算汇总、撰写报告”三个阶段完成任务，并使用产品待办更新真实状态。数据：甲产品销量10、单价20元；乙产品销量5、单价30元。先在当前任务目录保存明细.csv，再计算各产品金额和总金额，最后生成验收销售报告.docx，包含明细表和汇总结论。保留中间文件，不修改其他目录。':'先创建并更新本任务待办，再通过浏览器真实打开https://www.baidu.com/，将当次网页标题及两项不同的正文时事原文记录为当前任务目录的网页摘录.md，保留来源URL。两项原文分别写成Markdown引用行（每行以>开头），不要在引用行中加入编号、说明或改写。再据此生成网页摘要.docx，摘要正文自由组织，并在来源摘录部分保留这两项原文及来源URL，以便核对。请保留中间文件。如页面没有时事内容请明确说明实际看到的内容，不编造新闻，不替换为预设页面。';
  await send(prompt,{waitOptions:{observe}});
  const data=getData(),middle=await fs.readFile(path.join(control.directory,intermediate),'utf8'),reportText=await docxText(path.join(control.directory,report));
  for(const name of [intermediate,report]){await fs.copyFile(path.join(control.directory,name),path.join(dir,name));outputs.push({name,path:name});}
  if(sales){
   assert('中间CSV保留两种商品销量及单价',middle.split(/\r?\n/).some(line=>/甲/.test(line)&&/\b10\b/.test(line)&&/\b20\b/.test(line))&&middle.split(/\r?\n/).some(line=>/乙/.test(line)&&/\b5\b/.test(line)&&/\b30\b/.test(line)));
   const xml=strFromU8(unzipSync(await fs.readFile(path.join(control.directory,report)))['word/document.xml']);
   const rows=[...xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map(match=>match[1].replace(/<[^>]+>/g,' '));
   assert('DOCX报告实际明细表中两种商品金额正确',rows.some(row=>/甲/.test(row)&&/\b200(?:\.0+)?\b/.test(row))&&rows.some(row=>/乙/.test(row)&&/\b150(?:\.0+)?\b/.test(row)));
   assert('DOCX报告给出正确总金额350元',/总|合计|汇总/.test(reportText)&&/\b350(?:\.0+)?\b/.test(reportText));
   finish('真实销售报告及金额核对');if(seen.todosDuring)finish('规划及执行状态观察');if(seen.intermediateBeforeFinal)finish('中间CSV生成期间预览');
  }else{
   const visited=completedTools(data).filter(part=>/browser/i.test(part.tool)&&JSON.stringify(part.state.input).includes('baidu.com'));
   assert('本Session有完成的真实浏览器访问',visited.length>0);
   const observed=completedTools(data).filter(part=>/browser/i.test(part.tool)).map(part=>String(typeof part.state.output==='string'?part.state.output:JSON.stringify(part.state.output))).join('\n');
   if(/未.{0,4}(?:发现|找到)|没有.{0,8}(?:时事|新闻)|无法.{0,5}(?:访问|获取)/.test(middle))throw review('原表新闻素材前提未满足，已保留当次页面与产物，不把缺少时事内容判为已覆盖');
   const excerpts=[...new Set(middle.split(/\r?\n/).filter(line=>/^\s*>/.test(line)).map(line=>normalizeExcerpt(line.replace(/^\s*>\s*/,''))).filter(text=>text.length>=8))];
   const observedText=normalizeExcerpt(observed),documentText=normalizeExcerpt(reportText);
   const facts=excerpts.filter(text=>observedText.includes(text));
   await fs.writeFile(path.join(dir,'网页摘录核对.json'),JSON.stringify({excerpts:excerpts.length,sourceMatched:facts.length,documentMatched:facts.filter(text=>documentText.includes(text)).length},null,2));
   assert('两项不同原文摘录可在本次真实浏览输出核对',facts.length>=2&&middle.includes('baidu.com'));
   assert('DOCX来源部分保留可追溯摘录及URL',facts.slice(0,2).every(text=>documentText.includes(text))&&reportText.includes('baidu.com'));
   finish('本轮网页访问与内容留存');
   await ui(async()=>{await selectWorkbench(page,config,'浏览器',capture);const address=page.getByRole('textbox').filter({visible:true});const values=await address.evaluateAll(elements=>elements.map(element=>element.value));assert('浏览器工作台展示实际访问地址',values.some(value=>String(value).includes('baidu.com')));});finish('浏览器工作台真实页面');
  }
  await ui(async()=>{await previewTaskFile(page,config,intermediate,capture,sales?['甲','乙']:['baidu.com']);await previewTaskFile(page,config,report,capture,sales?['200','150','350']:[]);await selectWorkbench(page,config,'待办',capture);});
  const todos=await control.get('/session/'+getSessionId()+'/todo');await fs.writeFile(path.join(dir,'执行后待办.json'),JSON.stringify(todos,null,2));
  assert('本任务完成后真实待办全部完成',todos.length>=3&&todos.every(item=>item.status==='completed'));
  await ui(async()=>{for(const item of todos)assert('待办界面展示本轮节点：'+item.content,await page.getByText(item.content,{exact:true}).count()>0);});
  if(sales)finish('最终文件与待办查看');else{finish('中间及最终文件预览');if(seen.todosDuring)finish('待办执行前后状态');}
  if(remaining.size)throw review('真实业务及最终产物已检查，但未捕获以下过程分支：'+[...remaining].join('、'));
 }
}
