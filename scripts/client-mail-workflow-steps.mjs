import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openMailbox,modal,closeModal,list,openMailDetail,awaitMailAnalysis} from './client-mail-dashboard-steps.mjs';
import {weekStart,weeklyFacts,contactFacts,completeMailHistory,authorizedTestRecipient,disposableReminder,mailClient,sentMatches,externalReceipt,releaseMailOperations} from './mobilework-mail-operations.mjs';
import {beginMessageClipboard,expectMessageClipboard,restoreMessageClipboard} from './mobilework-message-clipboard.mjs';

const save=(c,name,value)=>fs.writeFile(path.join(c.dir,name+'.json'),JSON.stringify(value,null,2));
const review=message=>Object.assign(Error(message),{review:true});
const blocked=message=>Object.assign(Error(message),{blocked:true});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const day=86400000;
async function until(context,read,ready,message,timeout=60000){
 const end=Date.now()+timeout;let value;
 do{value=await read();if(ready(value))return value;await context.page.waitForTimeout(250);}while(Date.now()<end);
 throw blocked(message);
}
async function reply(context,mail){
 const {frame,data,baseline,issues}=mail;await list(context,mail);await frame.locator('[data-tab="all"]').click();
 const target=baseline?.messages.find(m=>data.allMail.some(a=>a.id===m.id))||data.allMail[0];if(!target)throw review('无真实收件样本，回复及起草未执行');
 const {actual}=await openMailDetail(context,mail,target.id,()=>frame.locator('#full-list .todo[data-open="'+target.id+'"]').click());await awaitMailAnalysis(context,mail);
 await modal(context,frame,'compose',()=>frame.locator('#d-reply').click());
 const subject=await frame.locator('#c-subject').inputValue();
 context.assert('回复弹框默认真实发件人与回复主题',await frame.locator('#c-to').innerText()===(actual.senderEmail?actual.senderName+' <'+actual.senderEmail+'>':actual.senderName)&&/^回复[:：]/.test(subject)&&subject.includes(actual.title.replace(/^(?:(?:re|回复|答复)\s*[:：]\s*)+/i,'')));
 context.assert('回复收件人只读且正文初始为空',await frame.locator('#c-to-input').isHidden()&&await frame.locator('#c-content').inputValue()==='');
 const hand='本轮回复编辑验证 '+randomUUID();await frame.locator('#c-content').fill(hand);context.assert('回复正文可以手工编辑',await frame.locator('#c-content').inputValue()===hand);await context.capture('回复默认字段及手工正文');await closeModal(context,frame,'compose');context.remaining.delete('回复默认字段与手工编辑');
 // AI drafting is a detail action in this version, separate from composer polish.
 const owned=context.resources.kanban.mail;owned.draftPending=true;owned.modals.push('compose');await context.checkpointResources();
 const sentBefore=data.sentMail.map(m=>m.id),sendRequests=[],watch=request=>{if(request.method()==='POST'&&/\/aggregate\/mail\/(?:send|[^/]+\/reply)$/.test(new URL(request.url()).pathname))sendRequests.push(new URL(request.url()).pathname);};context.page.on('request',watch);
 try{
  const [response]=await Promise.all([context.page.waitForResponse(async r=>{if(r.request().method()!=='POST'||new URL(r.url()).pathname!=='/aggregate/mail/'+encodeURIComponent(target.id)+'/draft')return false;if(!r.ok())return true;return !(await r.json()).pending;},{timeout:120000}),frame.locator('#d-draft').click()]);
  context.assert('真实AI起草请求成功',response.ok());const generated=await response.json();context.assert('真实AI起草返回非空草稿',typeof generated.draft==='string'&&!!generated.draft.trim());await frame.locator('#compose-modal').waitFor({state:'visible'});
  delete owned.draftPending;await context.checkpointResources();const draft=await frame.locator('#c-content').inputValue();context.assert('草稿真实填入且可编辑',draft===generated.draft&&await frame.locator('#c-content').isEditable());
  const facts=baseline?.messages.find(m=>m.id===target.id);if(facts?.replyFacts?.length)for(const fact of facts.replyFacts)context.assert('回复草稿独立业务事实',draft.includes(fact));else issues.push('缺独立回复事实，相关性与语气不能由模型自述或接口回显证明');
  for(const fact of facts?.replyForbiddenFacts||[])context.assert('草稿不引入禁止的业务事实',!draft.includes(fact));
  const edited=draft+'\n本轮人工补充：请以最终确认信息为准。';await frame.locator('#c-content').fill(edited);context.assert('AI草稿可继续人工修改',await frame.locator('#c-content').inputValue()===edited);await context.capture('AI起草真实内容及人工修改');await closeModal(context,frame,'compose');
  const next=await (await mailClient(context.page))('/dashboard');context.assert('起草及编辑未发送邮件',sendRequests.length===0&&next.sentMail.every(m=>sentBefore.includes(m.id)));await save(context,'回复与起草实际流程',{mailId:target.id,subject,draftLength:draft.length,sendRequests,sentCountBefore:sentBefore.length,sentCountAfter:next.sentMail.length});context.remaining.delete('真实AI起草相关草稿与编辑且不发送');
 }finally{context.page.off('request',watch);}
 await closeModal(context,frame,'detail');await closeModal(context,frame,'list');
}

async function weekly(context,mail){
 const {data,frame,baseline,issues}=mail,chart=frame.locator('#weekly svg');await chart.waitFor({state:'visible'});
 const labels=await chart.locator('text[text-anchor="middle"]').allTextContents(),bars=chart.locator('path[data-tip]'),points=chart.locator('circle[data-tip]');
 context.assert('周图按真实四周顺序展示收到和已处理',data.weekly.length===4&&same(labels,data.weekly.map(w=>w.label))&&await bars.count()===8&&await points.count()===4);
 for(let i=0;i<data.weekly.length;i++){
  const week=data.weekly[i];context.assert('周图柱体实际数值：'+week.label,await bars.nth(i*2).getAttribute('data-tip')==='收到 '+week.received&&await bars.nth(i*2+1).getAttribute('data-tip')==='已处理 '+week.handled);
  const expected=week.received>0?Math.round(week.handled/week.received*100):0;const actual=await points.nth(i).getAttribute('data-tip');context.assert('处理率保留真实分子分母：'+week.label,actual==='处理率 '+expected+'%');
  await points.nth(i).hover();await frame.locator('.mw-tip').filter({hasText:actual}).waitFor({state:'visible'});
 }
 const now=baseline?Date.parse(baseline.observedAt):Date.now(),history=completeMailHistory(baseline,weekStart(now)-21*day,now);
 if(history){const independent=weeklyFacts(history,now);for(let i=0;i<4;i++)context.assert('与独立完整邮箱周记录核对：'+data.weekly[i].label,independent[i].received===data.weekly[i].received&&independent[i].handled===data.weekly[i].handled);await save(context,'独立周统计对照',{observedAt:baseline.observedAt,expected:independent,actual:data.weekly});}else issues.push('缺覆盖本周及前三周的独立完整收件/处理时间记录，未用messages子集冒充总体统计');
 await context.capture('每周收件处理及处理率实际图表');context.remaining.delete('四周图表与独立收件处理统计');
}

async function meetingReminder(context,mail,target,row){
 const {fact,actual}=target,owned=context.resources.kanban.mail,call=await mailClient(context.page);
 owned.reminder={id:actual.id,sourceMailId:actual.sourceMailId,title:actual.title,startMs:actual.startMs,disposable:true,beforeLead:5,lastLead:5,proposedLead:15};await context.checkpointResources();
 const alerts=context.page.getByRole('alert').filter({has:context.page.getByText(fact.title,{exact:true})});context.assert('专用会议测试开始前没有同名提醒',await alerts.count()===0);
 for(const lead of [15,30,60]){
  owned.reminder.proposedLead=lead;await context.checkpointResources();await row.locator('.m-lead').click();await row.locator('.m-lead-input').fill(String(lead));
  const [response]=await Promise.all([context.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/aggregate/mail/meetings/'+encodeURIComponent(actual.id)+'/reminder'),row.locator('.m-lead-input').press('Enter')]);
  context.assert('真实提醒修改请求及分钟：'+lead,response.ok()&&response.request().postDataJSON().leadMinutes===lead);const result=await response.json();context.assert('提醒实际写入本轮会议：'+lead,result.reminder.meetingId===fact.id&&result.reminder.leadMinutes===lead);owned.reminder.lastLead=lead;await context.checkpointResources();await row.locator('.m-lead[data-lead-value="'+lead+'"]').waitFor();
 }
 context.remaining.delete('专用会议默认5分钟及真实修改15/30/60');
 // The final 60 minute lead is due now for this disposable 30-60 minute meeting.
 // Only observe the product's scheduler. Never call due/ack to manufacture a toast.
 await alerts.waitFor({state:'visible',timeout:65000});const text=await alerts.innerText(),link=fact.online.url.replace(/^https?:\/\//,'');const clock=await context.page.evaluate(ms=>{const d=new Date(ms);return d.getHours()+':'+String(d.getMinutes()).padStart(2,'0');},fact.startMs);context.assert('真实会议提醒主题时间会议号和链接',text.includes(fact.title)&&text.includes(clock)&&text.includes(fact.online.meetingNo)&&text.includes(link.length>40?link.slice(0,40)+'…':link));
 const box=await alerts.boundingBox(),viewport=await context.page.evaluate(()=>({w:innerWidth,h:innerHeight}));context.assert('实际提醒显示在窗口右下区域',box.x+box.width/2>viewport.w/2&&box.y+box.height/2>viewport.h/2);
 await context.capture('真实到点会议右下提醒');
 const at=Date.now();let observations=0,maxVisible=0;
 while(Date.now()-at<65000){maxVisible=Math.max(maxVisible,await alerts.count());observations++;await context.page.waitForTimeout(1000);}
 const state=(await call('/dashboard')).meetings.find(m=>m.id===fact.id);context.assert('两轮自然调度内没有重复可见提醒且真实显示已确认',maxVisible===1&&await alerts.count()===1&&!!state?.reminder?.firedAt);
 // Close this exact disposable toast only. Keep all unrelated reminders intact.
 await alerts.getByRole('button',{name:/关闭/}).click();await alerts.waitFor({state:'hidden'});await save(context,'会议真实到点及去重',{id:fact.id,startMs:fact.startMs,leadMinutes:60,observedAt:new Date(at).toISOString(),observationMs:Date.now()-at,observations});context.remaining.delete('真实自然到点弹框及两轮调度去重');
 await releaseMailOperations(context.page,owned);await context.checkpointResources();
}

async function meetings(context,mail){
 const {data,frame,baseline,issues}=mail;
 if(!data.meetings?.length)throw review('没有真实会议邮件，会议提取/提醒未覆盖');
 for(const meeting of data.meetings){
  const row=frame.locator('#meetings .meeting').filter({has:frame.locator('.m-src[data-open="'+meeting.sourceMailId+'"]')}).filter({has:frame.getByText(meeting.title,{exact:true})});const text=await row.innerText();context.assert('会议真实主题日期及时间',text.includes(meeting.title)&&text.includes(meeting.dateLabel)&&text.includes(meeting.timeLabel));
  if(meeting.online)context.assert('会议平台会议号与链接真实展示',text.includes(meeting.online.app)&&(!meeting.online.meetingNo||text.includes(meeting.online.meetingNo))&&(!meeting.online.url||await row.locator('.m-link').getAttribute('data-copy-url')===meeting.online.url));
  const fact=baseline?.meetings?.find(m=>m.id===meeting.id);
  if(fact){context.assert('独立原邮件会议主题时间和平台字段',meeting.title===fact.title&&meeting.startMs===fact.startMs&&['app','url','meetingNo'].every(k=>meeting.online?.[k]===fact.online[k]));}else issues.push('会议缺独立原邮件事实：'+meeting.id);
 }
 const selected=baseline?.meetings?.find(f=>data.meetings.some(m=>m.id===f.id))||data.meetings[0],actual=data.meetings.find(m=>m.id===selected.id),row=frame.locator('#meetings .meeting').filter({has:frame.locator('.m-src[data-open="'+actual.sourceMailId+'"]')}).filter({has:frame.getByText(actual.title,{exact:true})});
 if(actual.online?.url){
  const owner=randomUUID(),clipboard=await beginMessageClipboard(context.page,owner);
  if(clipboard.supported){context.resources.clipboardOwner=owner;await context.checkpointResources();await expectMessageClipboard(context.page,owner,actual.online.url);await row.locator('.m-link').click();await context.page.waitForFunction(async value=>(await navigator.clipboard.readText())===value,actual.online.url);context.assert('当前会议链接实际复制完整地址',await context.page.evaluate(()=>navigator.clipboard.readText())===actual.online.url);await restoreMessageClipboard(context.page,owner);delete context.resources.clipboardOwner;await context.checkpointResources();}else issues.push('剪贴板含不可恢复格式，会议链接复制未执行');
 }
 issues.push('原表会议链接跳转，当前入口仅复制；原关闭提醒UI未提供，不能用清理API冒充业务关闭');
 const detail=await openMailDetail(context,mail,actual.sourceMailId,()=>row.locator('.m-src').click());await awaitMailAnalysis(context,mail);context.assert('来源回看确为该会议原邮件',detail.actual.id===actual.sourceMailId&&detail.actual.title===actual.sourceSubject);await context.capture('会议来源真实详情');await closeModal(context,frame,'detail');context.remaining.delete('会议提取独立事实与链接及来源');
 const target=disposableReminder(baseline,data.meetings);if(!target){issues.push('缺默认5分钟、未触发且30～60分钟后开始的专用可丢弃测试会议，未修改用户提醒');return;}
 const targetRow=frame.locator('#meetings .meeting').filter({has:frame.locator('.m-lead[data-lead="'+target.fact.id+'"]')});await meetingReminder(context,mail,target,targetRow);
}

async function contacts(context,mail){
 const {data,frame,baseline,issues}=mail,rows=frame.locator('#senders .sender'),names=await rows.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-compose-name')));context.assert('联系人完整列表与真实响应逐项一致',same(names,data.senders.map(s=>s.name)));
 for(const sender of data.senders){const row=frame.locator('#senders .sender[data-compose-name='+JSON.stringify(sender.name)+']'),text=await row.innerText();context.assert('联系人数量近期主题和时间',text.includes(sender.count+' 封')&&text.includes(sender.lastReceivedAt)&&sender.recentSubjects.every(s=>text.includes(s)));}
 const now=baseline?Date.parse(baseline.observedAt):Date.now(),history=completeMailHistory(baseline,now-7*day,now);
 if(history){const expected=contactFacts(history,now),actual=data.senders.map(({name,count,email})=>({name,count,email:email||''}));context.assert('原表7天Top10及同数量最近来信排序',same(actual,expected.map(({name,count,email})=>({name,count,email}))));await save(context,'联系人原规则与实际对照',{expected,actual,currentProductRule:'安装版近30天Top8，保留原7天Top10目标'});}else issues.push('缺独立完整联系人收件记录，原表7天Top10及同数量排序待复核；安装版采用近30天Top8');
 await modal(context,frame,'compose',()=>frame.locator('#senders-compose').click());context.assert('写邮件标题入口打开空白新邮件',await frame.locator('#c-to-input').isVisible()&&await frame.locator('#c-to-input').inputValue()===''&&await frame.locator('#c-subject').inputValue()===''&&await frame.locator('#c-content').inputValue()==='');await closeModal(context,frame,'compose');
 const authorized=authorizedTestRecipient(baseline,data.senders),selected=authorized?data.senders.find(s=>s.name===authorized.name&&s.email===authorized.recipient):data.senders[0];
 if(!selected){issues.push('没有真实联系人，预填/发送未执行');return;}
 const contactName=frame.locator('#senders .sender[data-compose-name='+JSON.stringify(selected.name)+'] .sender-name');
 await contactName.scrollIntoViewIfNeeded();await context.capture('目标联系人姓名入口');
 await modal(context,frame,'compose',()=>contactName.click());
 context.assert('联系人打开新邮件只预填收件人不带旧主题',await frame.locator('#c-to-input').inputValue()===(selected.email?selected.name+' <'+selected.email+'>':'')&&await frame.locator('#c-subject').inputValue()===''&&await frame.locator('#c-content').inputValue()===''&&await frame.locator('#c-to').isHidden());context.remaining.delete('联系人原规则排序与空白新邮件预填');
 if(!authorized){issues.push('缺当天明确专用收件人发送授权，未向真实用户联系人发信');await closeModal(context,frame,'compose');return;}
 const subject='MW-Autotest-Mail-160-'+randomUUID(),marker='MW-mail-body-'+randomUUID();await frame.locator('#c-to-input').fill(authorized.recipient);await frame.locator('#c-subject').fill(subject);await frame.locator('#c-content').fill('MobileWork自动化专用测试邮件。\n'+marker+'\n请忽略本测试内容。');
 const owned=context.resources.kanban.mail;owned.send={beforeIds:data.sentMail.map(m=>m.id),recipient:authorized.recipient,subject,marker,startedAt:Date.now()};await context.checkpointResources();const send={...owned.send};
 const [response]=await Promise.all([context.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/aggregate/mail/send'),frame.locator('#c-send').click()]);context.assert('新邮件真实发送接口且无旧回复目标',response.ok()&&response.request().postDataJSON().to===send.recipient&&response.request().postDataJSON().subject===subject);await frame.locator('#compose-modal').waitFor({state:'hidden'});
 const call=await mailClient(context.page),sent=await until(context,async()=>sentMatches((await call('/dashboard')).sentMail,send),items=>items.length===1,'发信后本机唯一记录尚未确认');context.assert('真实发件箱记录匹配本轮唯一主题及收件人',sent.length===1);delete owned.send;owned.modals=owned.modals.filter(k=>k!=='compose');await context.checkpointResources();
 await list(context,mail);await frame.locator('[data-tab="sent"]').click();await frame.locator('#full-list').getByText(subject,{exact:true}).waitFor();await context.capture('本轮新邮件真实发件箱记录');await closeModal(context,frame,'list');
 const receipt=await externalReceipt(send);if(!receipt)issues.push('客户端发送记录已确认，缺独立收件箱同主题及正文标记收据，实际送达待复核');await save(context,'专用测试新邮件发送结果',{subject,recipient:send.recipient,sentId:sent[0].id,receipt,deliveryConfirmed:!!receipt});context.remaining.delete('专用收件人真实发送及发件箱与独立收据');
}

export async function runMailWorkflowSteps(context,prepared){
 const mail=await openMailbox(context,prepared);
 if(context.number===157)await reply(context,mail);else if(context.number===158)await weekly(context,mail);else if(context.number===159)await meetings(context,mail);else await contacts(context,mail);
 await save(context,'邮箱待复核项',{issues:mail.issues});if(mail.issues.length)throw review(mail.issues.join('；'));
}
