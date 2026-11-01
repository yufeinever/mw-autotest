import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {unzipSync} from 'fflate';
import {queueMessage,sessionMessageText} from './mobilework-message-queue.mjs';
import {queuedRow} from './mobilework-composer-resources.mjs';
import {selectWorkbench,previewTaskFile,matchToolDetailText} from './mobilework-task-ui.mjs';
import {xlsxRows,expandProcess} from './client-message-display-steps.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});
const panelOf=page=>page.locator('[data-slot="resizable-panel"]').filter({visible:true}).last();
const tools=data=>data.messages.flatMap(message=>message.parts.filter(part=>part.type==='tool').map(part=>({...part,messageId:message.info.id})));
const normalize=value=>String(value).replace(/\s+/g,' ').trim();
const longTask='请为虚构设备台账详细设计60项边界测试，分录入、搜索、导出三组，各20项，逐项说明输入、预期与边界理由，不省略、不合并，不调用工具或修改文件。';

export async function runQueueWorkbenchSteps(context){
 const {number,definition,page,config,control,dir,resources,remaining,outputs,assert,capture,log,send,waitBusy,getData,getSessionId}=context;
 const finish=step=>remaining.delete(step),save=(name,data)=>fs.writeFile(path.join(dir,name),JSON.stringify(data,null,2));
 const ui=action=>control.withUI(page,'INTERACTING',action);
 const queueHeader=title=>page.locator('button[title="'+title+'"]').filter({visible:true});
 const queuePanel=()=>page.locator('section').filter({has:page.locator('button[title="收起排队任务"],button[title="展开排队任务"]')});
 const queue=async text=>{const result=await queueMessage(context,text);await capture('排队消息-'+resources.queueTexts.length);return result;};
 const labels=()=>queuePanel().getByRole('listitem').filter({visible:true}).locator('span[title]').evaluateAll(elements=>elements.map(element=>element.title));
 async function waitQueue(expected,boundary,observe){
  await control.release(page);
  let data;
  for(let turn=0;turn<=expected.length;turn++){
   data=await control.wait(page,config,{timeoutMs:definition.timeoutMs,capture,log,afterMessageId:boundary,observe});
   const users=data.messages.filter(message=>message.info.role==='user');
   if(users.some(message=>sessionMessageText(message).includes(expected.at(-1))))return data;
   boundary=data.messages.at(-1).info.id;
  }
  throw review('保留队列未全部进入引擎，不能只凭首轮完成判断队列通过');
 }
 async function archiveFile(name){await fs.copyFile(path.join(control.directory,name),path.join(dir,name));outputs.push({name,path:name});}
 if(number===52||number===53){
  await send(longTask,{wait:false});await waitBusy();
  const tag=path.basename(dir),first=number===53?'首位长消息-'+tag+'：'+('合成设备边界说明，'.repeat(45))+'请只回答127加286。':'保留首项-'+tag+'：请只回答127加286。';
  const middle='中间队列-'+tag+'：请只回答111加222。',last='保留末项-'+tag+'：请只回答215加308。';
  const {before}=await queue(first);await queue(middle);await queue(last);
  const expected=[first,middle,last],initial=await labels();
  assert('三条本轮消息真实排队且顺序一致',JSON.stringify(initial)===JSON.stringify(expected),initial);
  assert('队列操作前没有提前发送本轮消息',!(await control.readLog()).messages.some(message=>message.info.role==='user'&&expected.some(text=>sessionMessageText(message).includes(text))));
  if(number===52){
   finish('执行中三条消息真实排队');
   await queuedRow(page,middle).getByRole('button',{name:'删除排队消息',exact:true}).click();
   await queuedRow(page,middle).waitFor({state:'hidden'});
   const after=await labels();
   assert('删除中间项后首尾消息和顺序保留',JSON.stringify(after)===JSON.stringify([first,last]),after);
   await save('排队删除前后.json',{before:initial,deleted:middle,after});await capture('删除中间排队消息');finish('删除目标及保留其他顺序');
   const data=await waitQueue([first,last],before.messages.at(-1).info.id),users=data.messages.filter(message=>message.info.role==='user').map(sessionMessageText);
   assert('删除项从未发给引擎且保留项按序执行',!users.some(text=>text.includes(middle))&&users.filter(text=>text.includes(first)||text.includes(last)).length===2&&users.findIndex(text=>text.includes(first))<users.findIndex(text=>text.includes(last)),users);
   assert('最后保留消息实际完成',data.messages.at(-1).parts.some(part=>part.type==='text'&&part.text.includes('523')));finish('删除项未发送及剩余执行');
  }else{
   const header=queueHeader('收起排队任务');
   assert('队列默认展开且三项可见',await header.getAttribute('aria-expanded')==='true'&&initial.length===3);finish('队列默认展开及长消息');
   const observations=[];
   for(let cycle=0;cycle<3;cycle++){
    await queueHeader('收起排队任务').click();
    const collapsed=queueHeader('展开排队任务');await collapsed.waitFor();
    const view=await collapsed.evaluate(element=>{const label=element.querySelector('span[title]'),rect=element.getBoundingClientRect(),style=getComputedStyle(label);return {expanded:element.getAttribute('aria-expanded'),label:label.title,rect:rect.toJSON(),ellipsis:style.textOverflow,overflow:style.overflowX,scrollWidth:label.scrollWidth,clientWidth:label.clientWidth,viewport:{width:innerWidth,height:innerHeight}};});
    observations.push({cycle,collapsed:view});
    assert('折叠仅显示首位并真实省略长文本-'+cycle,view.expanded==='false'&&view.label===first&&await queuePanel().getByRole('listitem').filter({visible:true}).count()===0&&view.ellipsis==='ellipsis'&&view.scrollWidth>view.clientWidth&&view.rect.right<=view.viewport.width&&view.rect.bottom<=view.viewport.height,view);
    const scroll=await page.locator('[data-session-messages="true"]:not([aria-hidden="true"])').evaluate(element=>{let parent=element;while(parent&&parent.scrollHeight<=parent.clientHeight+1)parent=parent.parentElement;if(!parent)return {scrollable:false};const before=parent.scrollTop;parent.scrollTop=before>0?0:parent.scrollHeight;return {scrollable:true,before,after:parent.scrollTop};});
    observations.at(-1).scroll=scroll;
    if(scroll.scrollable&&scroll.before!==scroll.after){
     const position=await collapsed.boundingBox();observations.at(-1).afterScroll=position;
     assert('滚动正文后队列保持固定位置-'+cycle,position&&Math.abs(position.y-view.rect.y)<2&&Math.abs(position.x-view.rect.x)<2,{before:view.rect,after:position});
    }
    if(cycle===0)await capture('队列折叠长消息');
    await collapsed.click();await queueHeader('收起排队任务').waitFor();
    assert('展开后消息完整且不丢失不乱序-'+cycle,JSON.stringify(await labels())===JSON.stringify(expected));
   }
   await save('队列收展观察.json',observations);finish('三次收展及长文本布局');
   if(observations.some(item=>item.scroll.scrollable&&item.scroll.before!==item.scroll.after))finish('队列固定及上方对话滚动');
   const observeScroll=async()=>{
    if(!remaining.has('队列固定及上方对话滚动'))return;
    const canScroll=await page.locator('[data-session-messages="true"]:not([aria-hidden="true"])').evaluate(element=>{for(let parent=element;parent;parent=parent.parentElement)if(parent.scrollHeight>parent.clientHeight+1)return true;return false;});
    if(!canScroll||!await queueHeader('收起排队任务').count())return;
    await ui(async()=>{
     await queueHeader('收起排队任务').click();const header=queueHeader('展开排队任务'),before=await header.boundingBox();
     const scroll=await page.locator('[data-session-messages="true"]:not([aria-hidden="true"])').evaluate(element=>{let parent=element;while(parent.scrollHeight<=parent.clientHeight+1)parent=parent.parentElement;const before=parent.scrollTop;parent.scrollTo({top:before>0?0:parent.scrollHeight,behavior:'instant'});return {before,after:parent.scrollTop};});
     const after=await header.boundingBox();
     assert('正文形成后滚动且队列保持固定位置',scroll.before!==scroll.after&&Math.abs(before.x-after.x)<2&&Math.abs(before.y-after.y)<2,{scroll,before,after});
     observations.push({duringWait:true,scroll,before,after});await capture('正文滚动时队列固定');await header.click();finish('队列固定及上方对话滚动');
    });
   };
   const data=await waitQueue(expected,before.messages.at(-1).info.id,observeScroll),users=data.messages.filter(message=>message.info.role==='user').map(sessionMessageText);
   await save('队列收展观察.json',observations);
   if(remaining.has('队列固定及上方对话滚动'))log('滚动覆盖缺口','队列存续期间未形成可滚动正文，保留待复核');
   assert('收展不改变三条消息实际执行顺序',JSON.stringify(users.slice(-3))===JSON.stringify(expected),users.slice(-3));finish('消息实际依次发送完成');
  }
 }else if(number===54){
  const file='双表销售数据.xlsx';
  const rows=Array.from({length:10},(_,i)=>['产品'+String(i+1).padStart(2,'0'),i+1,10,(i+1)*10]);
  await send('请在本任务目录生成“'+file+'”，恰有两个工作表“销售一”和“销售二”，内容完全相同：列为产品名称、销量、单价、金额，数据如下：'+JSON.stringify(rows)+'。金额可用真实数值或对应公式。建立真实待办，完成后标记完成。然后通过浏览器实际打开https://example.com/，读取当次网页标题。不要联网下载其他资料或修改其他目录。最终提供Excel入口。');
  const archive=unzipSync(await fs.readFile(path.join(control.directory,file))),sheets=Object.keys(archive).filter(name=>/^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  assert('真实Excel恰好包含两张工作表',sheets.length===2,sheets);
  const tables=sheets.map(name=>xlsxRows(Object.fromEntries(Object.entries(archive).filter(([key])=>!/^xl\/worksheets\/sheet\d+\.xml$/.test(key)||key===name))));
  assert('两表列名正确各十行明细且业务数值相同',tables.every(table=>table[0]==='产品名称 销量 单价 金额'&&table.length===11&&rows.every((row,i)=>table[i+1]===row.join(' ')))&&JSON.stringify(tables[0])===JSON.stringify(tables[1]),tables);await archiveFile(file);finish('双Sheet真实Excel及明细');
  await ui(async()=>{
   await previewTaskFile(page,config,file,capture);const panel=panelOf(page);
   assert('预览工作台与本Session对话同时可见',await panel.isVisible()&&await page.locator('[data-session-messages="true"]:not([aria-hidden="true"])').isVisible());finish('产物与主界面并行预览');
   await selectWorkbench(page,config,'待办',capture);const todos=await control.get('/session/'+getSessionId()+'/todo');
   const todoText=await panelOf(page).innerText();
   assert('待办面板展示本Session真实事项',todos.length>0&&todos.every(item=>item.status==='completed')&&todos.every(item=>todoText.includes(item.content)),todos);
   await save('工作台待办.json',todos);finish('待办实际内容切换');
   const visited=tools(getData()).filter(tool=>tool.state.status==='completed'&&/browser/i.test(tool.tool)&&JSON.stringify(tool.state).includes('example.com'));
   if(!visited.length)throw review('没有本Session真实浏览器访问证据，不能以文本检索代替浏览器面板验证');
   await selectWorkbench(page,config,'浏览器',capture);
   const address=panelOf(page).getByRole('textbox').filter({visible:true});
   assert('浏览器面板显示实际访问URL',(await address.evaluateAll(elements=>elements.map(element=>element.value))).some(value=>value.includes('example.com')));finish('浏览器真实内容切换');
   const hide=button(page,'关闭右边栏');await hide.click();await button(page,'显示右边栏').waitFor();await capture('工作台收起');
   await button(page,'显示右边栏').click();await button(page,'切换面板功能').waitFor();await capture('工作台重新展开');finish('工作台收起展开');
  });
 }else if(number===55){
  const file='调用链核验.txt',marker='星桥调用链-'+randomUUID();
  await send('请先简要说明本次写入后读取的计划，然后在当前任务目录新建“'+file+'”，正文为“'+marker+'”，再实际读取校验。完成后简要总结。只操作此合成文件。');
  assert('任务通过实际工具写入并读取唯一内容',(await fs.readFile(path.join(control.directory,file),'utf8')).trim()===marker);await archiveFile(file);
  const complete=tools(getData()).filter(tool=>tool.state.status==='completed'&&JSON.stringify(tool.state).includes(marker));
  assert('工具链包含本轮真实完成调用',complete.length>=1,complete.map(tool=>({tool:tool.tool,callID:tool.callID})));finish('本轮真实思考及工具链');
  await ui(async()=>{
   await expandProcess(page);
   const messageArea=page.locator('[data-session-messages="true"]:not([aria-hidden="true"])'),cards=messageArea.locator('button[aria-label="在工作台查看工具调用详情"],button.group.cursor-pointer.text-start');
   const matched=[];
   for(let i=0;i<await cards.count();i++){
    await cards.nth(i).click();const text=normalize(await panelOf(page).innerText());
    for(const tool of complete.filter(tool=>matchToolDetailText(tool,text))){
     if(!matched.some(item=>item.callID===tool.callID)){matched.push({callID:tool.callID,tool:tool.tool,messageId:tool.messageId,...matchToolDetailText(tool,text)});await capture('真实调用详情-'+matched.length);}
    }
   }
   if(!matched.length)throw review('工具实际完成，但详情尚未匹配真实输入输出，保留面板证据');
   assert('详情内容关联本轮真实调用而非其他Session',matched.length>0,matched);await save('工具链详情匹配.json',matched);
   if(complete.every(tool=>matched.some(item=>item.callID===tool.callID&&!item.missingInputFields.length)))finish('详情关联真实入参出参');
   else log('调用链覆盖缺口','部分相关完成工具尚未在详情中匹配，不能将一张详情冒充完整链路');
   const reasoning=getData().messages.flatMap(message=>message.parts).filter(part=>part.type==='reasoning'&&part.text?.trim());
   const reasoningButton=messageArea.getByRole('button',{name:/深度思考|思考过程/}).filter({visible:true});
   if(reasoning.length&&await reasoningButton.count()){
    const first=reasoningButton.first();if(await first.getAttribute('aria-expanded')!=='true')await first.click();
    const body=first.locator('xpath=..').locator('.deep-think-body');await body.waitFor();
    const canonical=value=>String(value).replace(/^\s*\d+[.)、]\s*/gm,'').replace(/[\p{P}\p{S}\s]/gu,'');
    const displayed=canonical(await body.innerText()),snippet=canonical(reasoning[0].text).slice(0,60);
    assert('展开的思考内容对应本轮实际reasoning',displayed.includes(snippet),{length:reasoning[0].text.length,snippet});await capture('真实思考详情');finish('实际思考展开核对');
   }else log('思考覆盖缺口','本轮没有可核对的reasoning或可展开入口，不用正文计划冒充模型思考');
  });
 }else if(number===56){
  const file='缺省页核验.txt',marker='星桥缺省页-'+randomUUID();
  await send('请在当前任务目录生成“'+file+'”，内容为“'+marker+'”，最终提供文件入口。只操作此合成文件。');
  assert('本轮文件实际存在且内容正确',(await fs.readFile(path.join(control.directory,file),'utf8')).trim()===marker);await archiveFile(file);
  await ui(async()=>{
   await previewTaskFile(page,config,file,capture,[marker]);const panel=panelOf(page);
   await panel.getByRole('button',{name:'关闭 '+file,exact:true}).click();
   assert('关闭预览标签保留本轮真实文件',(await fs.readFile(path.join(control.directory,file),'utf8')).trim()===marker);
   const tabs=panel.getByRole('button',{name:/^关闭 /});
   assert('关闭本轮文件后没有已选中文件标签',await tabs.count()===0);finish('本轮有产物但未选中文件');
   await panel.getByText('暂无数据',{exact:true}).waitFor();
   assert('未选择文件时显示可见缺省页',await panel.getByText('暂无数据',{exact:true}).isVisible()&&await panel.locator('iframe').count()===0);await capture('未选文件缺省页');finish('缺省提示及无错误预览');
   await selectWorkbench(page,config,'待办',capture);await selectWorkbench(page,config,'产物',capture);
   assert('切换返回后仍是本Session缺省页',await panelOf(page).getByText('暂无数据',{exact:true}).isVisible()&&await panelOf(page).getByRole('button',{name:/^关闭 /}).count()===0);finish('面板往返仍为空状态');
  });
 }
}
