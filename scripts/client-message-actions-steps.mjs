import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {finalAssistantText} from './client-case-runner.mjs';
import {snapshotDraft,clearOwnedDraft,editorOf} from './mobilework-isolation.mjs';
import {readComposerState} from './mobilework-composer.mjs';
import {queuedRow} from './mobilework-composer-resources.mjs';
import {queueMessage,interveneQueued,sessionMessageText} from './mobilework-message-queue.mjs';
import {beginMessageClipboard,expectMessageClipboard,restoreMessageClipboard} from './mobilework-message-clipboard.mjs';
import {usageSnapshot,totalTokens,generationFacts} from './client-loading-usage-steps.mjs';
import {saveRunTrace} from './mobilework-trace.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const root=page=>page.locator('[data-session-messages="true"]:not([aria-hidden="true"])');
const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});
const timeText=epoch=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(epoch);
const toolParts=data=>data.messages.flatMap(message=>(message.parts||[]).filter(part=>part.type==='tool'));

export async function runMessageActionsSteps(context){
 const {number,definition,page,config,control,dir,resources,remaining,outputs,assert,capture,log,send,fill,markDraftSent,waitBusy,checkpointResources,getData,getSessionId}=context;
 const finish=step=>remaining.delete(step),ui=action=>control.withUI(page,'INTERACTING',action);
 const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
 async function replaceDraft(text){
  const previous=await snapshotDraft(page);await control.checkpointDraft(previous);
  if(!await clearOwnedDraft(page,previous,config))throw Error('本轮回填草稿归属未确认');
  await fill(text);
 }
 async function copyAndPaste(message,text,{contextMenu=false}={}){
  await ui(async()=>{
   const owner=randomUUID(),baseline=await beginMessageClipboard(page,owner);
   if(!baseline.supported)throw review('当前剪贴板含浏览器无法原样恢复的格式，保留原内容，复制分支待验证');
   resources.clipboardOwner=owner;await checkpointResources();
   try{
    await message.scrollIntoViewIfNeeded();await message.click();
    const position=await message.evaluate((element,text)=>{
     const nodes=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node;
     while(node=nodes.nextNode()){
      const start=node.textContent.indexOf(text);if(start<0)continue;
      const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+text.length);
      const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      const rect=range.getBoundingClientRect(),box=element.getBoundingClientRect();return {x:rect.x-box.x+rect.width/2,y:rect.y-box.y+rect.height/2};
     }
     throw Error('本轮消息中未找到可选择的目标文本');
    },text);
    assert('实际消息部分文本已选中',await page.evaluate(()=>getSelection().toString())===text);
    await expectMessageClipboard(page,owner,text);
    if(contextMenu){
     await message.click({button:'right',position});
     const copy=page.getByRole('button',{name:'复制',exact:true}).filter({visible:true});
     await copy.waitFor();
     await copy.click();
    }else await page.keyboard.press('Control+c');
    // Clipboard writes are asynchronous; wait for their real result, not a delay.
    await page.waitForFunction(async text=>(await navigator.clipboard.readText())===text,text);
    const copied=await page.evaluate(()=>navigator.clipboard.readText());
    await expectMessageClipboard(page,owner,copied);
    assert('系统剪贴板内容与选中消息逐字一致',copied===text);
    const editor=editorOf(page);await editor.click();
    // Register expected draft before a genuine OS paste, including stop recovery.
    const draft=await snapshotDraft(page);await control.checkpointDraft({...draft,text});
    await page.keyboard.press('Control+v');
    await page.waitForFunction(text=>[...document.querySelectorAll('[contenteditable="true"]')].some(element=>element.textContent===text),text);
    const pasted=(await readComposerState(editor)).text;
    assert('真实粘贴结果与选中消息逐字一致',pasted===text);await capture('消息复制粘贴核对');
    const owned=await snapshotDraft(page);await control.checkpointDraft(owned);
    if(!await clearOwnedDraft(page,owned,config))throw Error('本轮复制粘贴草稿未完成收尾');
    await control.call('checkpoint',{draft:null});
   }finally{
    const restored=await restoreMessageClipboard(page,owner);log('剪贴板收尾',restored.restored?'原内容已恢复':restored.reason);
    delete resources.clipboardOwner;await checkpointResources();
   }
  });
 }
 async function waitQueuedResult(boundary){
  await control.release(page);
  return control.wait(page,config,{timeoutMs:definition.timeoutMs,capture,log,afterMessageId:boundary});
 }
 const queueContext={...context,fill:async text=>{await fill(text);}};

 if(number===47){
  await send('请用一小段纯文本介绍这个虚构项目：星桥设备盘点，预算7300元，责任人林悦，验收日期2026年11月6日。不调用外部服务，不生成文件。');
  const data=getData(),assistant=data.messages.filter(message=>message.info?.role==='assistant').at(-1);
  const message=root(page).locator('[data-message-id="'+assistant.info.id+'"]').first();await message.waitFor();
  await ui(async()=>{
   const stats=await usageSnapshot(page),total=totalTokens(data);
   assert('本条消息悬停统计对应本Session实际Token',stats.tokens===(total/10000).toFixed(2)+'万token',stats);
   assert('本条消息显示速度、耗时与成功状态',/^\d+\.\d{2}t\/s$/.test(stats.rate)&&!!stats.duration&&stats.success,stats);
   const facts=generationFacts(data),duration=stats.duration.match(/(?:(\d+)h )?(?:(\d+)m )?(\d+)s$/);
   assert('本条消息耗时对应实际助手起止时间',!!duration&&Number(duration[1]||0)*3600+Number(duration[2]||0)*60+Number(duration[3])===facts.elapsed,{actual:stats.duration,expectedSeconds:facts.elapsed});
   if(facts.ms<=0||facts.output<=0)throw review('本条消息缺少可计算速度的真实Token/生成时段，速度对账待验证');
   assert('本条消息速度对应实际输出量及生成时段',stats.rate===(facts.output/(facts.ms/1000)).toFixed(2)+'t/s',{actual:stats.rate,output:facts.output,ms:facts.ms});
   const completed=Math.max(...data.messages.filter(message=>message.info?.role==='assistant').map(message=>message.info.time.completed));
   const completion=root(page).getByLabel('生成完成时间',{exact:true});
   await completion.hover();
   const actual=await completion.innerText(),expected=timeText(completed).slice(11,16);
   assert('回复时间对应本Session最后完成时间',actual===expected,{actual,expected,epoch:completed});
   await save('消息统计与时间.json',{stats,total,completed,actual});await capture('助手消息悬停统计');finish('回复消息悬停统计与时间');
  });
  // Preserve the entire original conversation before the product deletes one message.
  const beforeDir=path.join(dir,'撤销前');await fs.mkdir(beforeDir);
  const archive=await saveRunTrace({page,sessionId:getSessionId(),number,dir:beforeDir,checks:[],log,readLog:children=>control.readLog(children)});
  if(archive.error)throw Error('撤销前证据保存失败：'+archive.error);
  outputs.push({name:'撤销前会话日志',path:'撤销前/'+getSessionId()+'-session-log.json'},{name:'撤销前Trace',path:'撤销前/trace.json'});
  // A copy failure must not suppress independent revert coverage.
  let copyGap;
  try{await copyAndPaste(message,'星桥设备盘点',{contextMenu:true});finish('部分回复右键复制与真实粘贴');}
  catch(error){if(!error.review)throw error;copyGap=error.message;log('复制覆盖缺口',copyGap);}
  await ui(async()=>{
   await message.hover();
   const group=message.locator('xpath=ancestor::div[contains(concat(" ",@class," ")," group/message-group ")][1]');
   await group.getByRole('button',{name:'撤销',exact:true}).click();await message.waitFor({state:'hidden'});
   const after=await control.readLog();
   assert('撤销后目标消息实际从引擎移除',!after.messages.some(item=>item.info.id===assistant.info.id));
   assert('撤销保留本轮用户消息及同一Session',data.messages.filter(item=>item.info.role==='user').every(item=>after.messages.some(current=>current.info.id===item.info.id))&&page.url().endsWith(getSessionId()));
   await save('撤销后消息ID.json',after.messages.map(item=>({id:item.info.id,role:item.info.role})));await capture('助手消息撤销完成');finish('本条回复真实撤销');
  });
  if(copyGap)throw review(copyGap);
 }else if(number===48){
  const task='这是隔离的多专家协作用例。请实际通过任务/子智能体工具依次委派两位不同专家，每位都必须创建自己的子会话，不能仅在你的回复中模拟角色。第一位任务标题为“星桥库存专家”，独立计算18+27，给出依据；完成后再委派第二位，任务标题“星桥质检专家”，独立计算43-4，给出依据。不要联网，不修改用户文件。你作为主会话汇总两位的实际结果。';
  const observations=[];
  await send(task,{waitOptions:{observe:async({states})=>{
   const main=await control.readLog(),parts=toolParts(main).filter(part=>part.tool==='task');
   if(parts.length)observations.push({at:Date.now(),main:states[getSessionId()]?.type,tools:parts.map(part=>({id:part.callID,status:part.state.status,metadata:part.state.metadata}))});
  }}});
  const children=await control.get('/session/'+getSessionId()+'/children');
  await save('专家运行状态采样.json',observations);await save('专家子会话.json',children);
  if(children.length<2)throw review('未触发至少两个真实专家子会话，不能用模型扮演多角色代替');
  assert('本轮主Session实际拥有至少两个独立子会话',new Set(children.map(child=>child.id)).size>=2&&children.every(child=>child.parentID===getSessionId()));finish('实际专家子会话及状态');
  const assignments=toolParts(getData()).filter(part=>part.tool==='task'&&part.state.metadata?.sessionId).map(part=>({part,child:children.find(child=>child.id===part.state.metadata.sessionId),title:part.state.input?.description||part.state.title}));
  assert('专家入口能够关联实际工具与子Session',assignments.length>=2&&assignments.every(item=>item.child&&item.title));
  assert('主回复汇总两位专家实际结果',['45','39'].every(value=>finalAssistantText(getData()).includes(value)));
  await ui(async()=>{
   await button(page,'主会话').waitFor();
   const tabs=button(page,'主会话').locator('xpath=..').getByRole('button');
   assert('主会话及专家入口并列展示',await tabs.count()>=3);
   for(let index=0;index<2;index++){
    const {child,part,title}=assignments[index],messages=await control.get('/session/'+child.id+'/message');
    await fs.writeFile(path.join(dir,child.id+'-session-log.json'),JSON.stringify({session:child,messages},null,2));
    outputs.push({name:'专家'+(index+1)+'会话日志',path:child.id+'-session-log.json'});
    resources.subSessionView=true;await checkpointResources();
    const tab=tabs.filter({hasText:title});assert('任务标题唯一关联专家入口'+index,await tab.count()===1,title);await tab.click();
    const assistant=messages.filter(message=>message.info.role==='assistant'&&(message.parts||[]).some(part=>part.type==='text')).at(-1);
    if(!assistant)throw review('子会话尚无可核对助手正文');
    const expected=/18|27/.test(part.state.input.prompt)?'45':/43|4/.test(part.state.input.prompt)?'39':null;
    if(!expected)throw review('专家实际委派输入不能关联两个计算目标，保留工具入参待核对');
    assert('专家实际完成其委派计算'+index,sessionMessageText(assistant).includes(expected));
    await root(page).locator('[data-message-id="'+assistant.info.id+'"]').first().waitFor();
    assert('专家窗口切换展示对应子会话'+(index+1),await root(page).locator('[data-message-id="'+assistant.info.id+'"]').count()>0);
    // The shared composer may remain mounted; its sending controls must be unavailable.
    assert('查看专家时不能向子会话继续发送'+(index+1),await editorOf(page).filter({visible:true}).count()===0||await editorOf(page).getAttribute('contenteditable')!=='true'||await button(page,'运行任务').count()===0);
    await capture('专家子会话-'+(index+1));
    await button(page,'主会话').click();delete resources.subSessionView;await checkpointResources();
   }
   finish('专家切换及只读约束');
  });
  await send('主窗口继续对话：请计算127加286，用一句话给出结果。',{continuing:true});
  assert('主窗口可正常继续发送并完成',finalAssistantText(getData()).includes('413'));finish('主会话续轮正常');
  // Color dots are the product's actual state indicators, not hardcoded textual labels.
  await ui(async()=>{
   const tabs=button(page,'主会话').locator('xpath=..').getByRole('button');
   const states=await control.get('/session/status');
   for(const {title,part,child} of assignments.slice(0,2)){
    const colors=await tabs.filter({hasText:title}).locator('span.rounded-full').evaluateAll(elements=>elements.map(e=>getComputedStyle(e).backgroundColor));
    assert('专家完成状态指示与实际终态一致：'+title,part.state.status==='completed'&&states[child.id]?.type!=='busy'&&colors.includes('rgb(34, 206, 118)'),colors);
   }
   await capture('专家状态与主窗口');finish('专家展示状态与引擎一致');
  });
 }else if(number===49){
  const inputs=path.join(dir,'隔离统计材料');await fs.mkdir(inputs);
  // Deliberate synthetic legacy extensions: counting names does not test Office parsing.
  for(const name of ['台账一.xls','台账二.xls','报告一.doc','报告二.doc','报告三.doc','忽略.xlsx','说明.txt'])await fs.writeFile(path.join(inputs,name),'合成文件名统计样本，不用于Office解析');
  await save('统计样本清单.json',{directory:inputs,files:await fs.readdir(inputs),expected:{xls:2,doc:3}});
  await send('只统计这个隔离目录 '+inputs+' 中扩展名严格为.xls的文件数量，不含.xlsx。先读取真实文件列表，再逐项核对，最后给出数量和名称。不要访问桌面或其他目录。统计后继续详细分析40项文件分类边界。',{wait:false});await waitBusy();
  const next='人工接入：结束上一轮详细分析，只读取 '+inputs+' 的一级目录，统计扩展名严格为.doc的文件，输出数量和全部名称，不含.docx，不访问其他目录。';
  const {before}=await queueMessage(queueContext,next);await capture('统计任务执行中消息排队');
  assert('排队消息尚未进入引擎',!(await control.readLog()).messages.some(message=>message.info.role==='user'&&sessionMessageText(message).includes(next)));finish('真实统计任务与排队');
  const boundary=await interveneQueued(queueContext,next);await capture('统计任务人工介入');
  const data=await waitQueuedResult(boundary),index=data.messages.findIndex(message=>message.info.role==='user'&&sessionMessageText(message).includes(next));
  assert('接入消息实际发送且结果匹配隔离样本',index>0&&['3','报告一.doc','报告二.doc','报告三.doc'].every(text=>finalAssistantText(data).includes(text)));
  const reads=toolParts({messages:data.messages.slice(index)}).filter(part=>part.state.status==='completed');
  const parsed=data.messages[index].parts.some(part=>part.type==='text'&&part.text?.includes('<type>directory</type>')&&['报告一.doc','报告二.doc','报告三.doc'].every(name=>part.text.includes(name)));
  assert('第二任务取得本轮目录真实读取内容',parsed||reads.some(part=>JSON.stringify(part.state.output).includes('报告三.doc')));finish('介入后实际目录统计');
  const old=data.messages.slice(before.messages.findIndex(message=>message.info.role==='user'),index);
  const aborted=old.some(message=>/abort|interrupt|cancel/i.test(JSON.stringify(message.info.error||'')));
  await save('人工介入顺序核对.json',{boundary,newUserId:data.messages[index].info.id,aborted,priorMessages:old.map(message=>({id:message.info.id,time:message.info.time,error:message.info.error}))});
  if(!aborted)throw review('第二任务已完成，但缺少上一轮实际中止证据，不能仅凭最终答案判介入通过');finish('原轮实际中止证据');
 }else if(number===50){
  const text='用户消息核对：星桥设备预算7300元，负责人林悦。请只说明这段虚构信息的用途，不调用工具。';
  await send(text);
  const user=getData().messages.find(message=>message.info.role==='user'),message=root(page).locator('[data-message-id="'+user.info.id+'"]').first();
  await ui(async()=>{
   await message.hover();
   const timestamp=message.locator('span.select-none').filter({hasText:/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/});await timestamp.waitFor();
   const actual=await timestamp.innerText(),expected=timeText(user.info.time.created);
   assert('用户消息悬停时间与实际发送时间一致',actual===expected,{actual,expected});await capture('用户消息发送时间');finish('用户消息悬停真实发送时间');
  });
  await copyAndPaste(message,'星桥设备预算7300元，负责人林悦。');finish('用户消息复制与真实粘贴');
 }else if(number===51){
  await send('请详细设计虚构设备台账的100条边界测试，分成录入、权限、搜索、导出、归档五组，每组20条，各写出输入和预期，逐项分析，不省略，不修改文件。',{wait:false});await waitBusy();
  const original='旧版排队-'+path.basename(dir)+'：请计算111加222。',replacement='新版排队-'+path.basename(dir)+'：只计算215加308，用一句话给出结果。';
  await queueMessage(queueContext,original);await capture('待编辑的真实排队消息');finish('执行中真实消息排队');
  await queuedRow(page,original).getByRole('button',{name:'编辑排队消息',exact:true}).click();
  await page.waitForFunction(expected=>[...document.querySelectorAll('[contenteditable="true"]')].some(element=>element.textContent===expected),original);
  const restored=await snapshotDraft(page);await control.checkpointDraft(restored);
  assert('点击编辑后原消息回填输入区且从队列移出',restored.text===original&&await queuedRow(page,original).count()===0);await capture('排队消息回填编辑');finish('编辑回填真实内容');
  await replaceDraft(replacement);
  if((await control.get('/session/status'))[getSessionId()]?.type!=='busy')throw review('编辑期间首轮已完成，未覆盖重新加入排队分支');
  resources.queueTexts.push(replacement);await checkpointResources();
  const boundary=(await control.readLog()).messages.at(-1).info.id;
  await button(page,'发送并加入排队').click();await markDraftSent();await queuedRow(page,replacement).waitFor();
  assert('修改后队列只显示新版且旧版未发送',await queuedRow(page,original).count()===0&&!(await control.readLog()).messages.some(message=>message.info.role==='user'&&sessionMessageText(message).includes(original)));await capture('修改后重新排队');finish('修改重新排队并更新展示');
  const data=await waitQueuedResult(boundary),users=data.messages.filter(message=>message.info.role==='user');
  assert('最终实际发送新版且旧版从未发送',users.some(message=>sessionMessageText(message).includes(replacement))&&!users.some(message=>sessionMessageText(message).includes(original)));
  assert('修改后的排队任务实际完成',finalAssistantText(data).includes('523'));await save('队列编辑发送核对.json',{original,replacement,userMessages:users.map(message=>({id:message.info.id,text:sessionMessageText(message),time:message.info.time}))});finish('最终只执行新版消息');
 }
 resources.queueTexts=[];await ui(checkpointResources);
}
