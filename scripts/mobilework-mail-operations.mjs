import fs from 'node:fs/promises';
import {beijingDate} from './mobilework-mail-baseline.mjs';

const day=86400000;
const blocked=message=>Object.assign(Error(message),{blocked:true});
export function weekStart(now){
 const midnight=Date.parse(beijingDate(now)+'T00:00:00+08:00'),weekday=new Date(midnight+8*3600000).getUTCDay();
 return midnight-((weekday+6)%7)*day;
}
export function weeklyFacts(history,now){
 return Array.from({length:4},(_,index)=>{
  const from=weekStart(now)-(3-index)*7*day,to=from+7*day;
  return {from,to,received:history.records.filter(m=>m.timeMs>=from&&m.timeMs<to).length,handled:history.records.filter(m=>m.handledAt>=from&&m.handledAt<to).length};
 });
}
export function contactFacts(history,now,{days=7,top=10}={}){
 const groups=new Map();
 for(const item of history.records.filter(m=>m.timeMs>=now-days*day&&m.timeMs<=now).sort((a,b)=>b.timeMs-a.timeMs)){
  if(!item.senderName||item.senderName==='未知发件人')continue;
  if(!groups.has(item.senderName))groups.set(item.senderName,{name:item.senderName,email:item.senderEmail||'',count:0,lastTimeMs:item.timeMs,subjects:[]});
  const group=groups.get(item.senderName);group.count++;if(group.subjects.length<3)group.subjects.push(item.title);
 }
 return [...groups.values()].sort((a,b)=>b.count-a.count||b.lastTimeMs-a.lastTimeMs).slice(0,top);
}
export function completeMailHistory(baseline,from,through){
 const history=baseline?.history;
 return history?.complete===true&&history.fromMs<=from&&history.throughMs>=through?history:null;
}
export function authorizedTestRecipient(baseline,senders,now=Date.now()){
 const send=baseline?.send;
 return send?.authorized===true&&beijingDate(send.confirmedAt)===beijingDate(now)&&senders.some(s=>s.name===send.name&&s.email===send.recipient)?send:null;
}
export function disposableReminder(baseline,meetings,now=Date.now()){
 const fact=baseline?.meetings?.find(f=>f.disposable===true&&f.testReminder===true&&f.startMs>now+30*60000&&f.startMs<=now+60*60000);
 if(!fact)return null;
 const actual=meetings.find(m=>m.id===fact.id&&m.sourceMailId===fact.sourceMailId&&m.title===fact.title&&m.startMs===fact.startMs);
 return actual?.reminder?.leadMinutes===5&&!actual.reminder.claimedAt&&!actual.reminder.firedAt?{fact,actual}:null;
}
export async function mailClient(page){
 const info=await page.evaluate(()=>window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo')),url=new URL(info.baseUrl);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('邮箱服务不是本机地址');
 const headers={Authorization:'Bearer '+(info.ownerToken||info.clientToken),'content-type':'application/json',...(info.hostToken?{'X-OpenWork-Host-Token':info.hostToken}:{})};
 return async(route,{method='GET',body}={})=>{
  const response=await fetch(info.baseUrl.replace(/\/$/,'')+'/aggregate/mail'+route,{method,headers,signal:AbortSignal.timeout(15000),...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Object.assign(Error('邮箱接口失败 '+route+'：HTTP '+response.status),{status:response.status});return response.json();
 };
}
export function sentMatches(items,send){return items.filter(m=>!send.beforeIds.includes(m.id)&&m.title===send.subject&&m.recipient===send.recipient&&m.timeMs>=send.startedAt);}
export async function externalReceipt(send){
 const file=process.env.MW_TEST_MAIL_RECEIPT;if(!file)return null;
 const value=JSON.parse(await fs.readFile(file,'utf8'));
 return value.source==='external-test-mailbox'&&value.recipient===send.recipient&&value.subject===send.subject&&value.body.includes(send.marker)&&Date.parse(value.receivedAt)>=send.startedAt?{receivedAt:value.receivedAt,messageId:value.messageId}:null;
}

// Recovery observes a pending send before touching its dialog; it never retries
// an uncertain external operation. Only dedicated, registered reminders cancel.
export async function releaseMailOperations(page,mail,{client=mailClient}={}){
 if(!mail.draftPending&&!mail.send&&!mail.reminder)return;
 const call=await client(page);
 if(mail.send){
  const sent=sentMatches((await call('/dashboard')).sentMail,mail.send);
  if(sent.length!==1)throw blocked('本轮发信结果仍未唯一确认，保留现场且不重发');
  delete mail.send;
 }
 if(mail.reminder){
  const owned=mail.reminder,data=await call('/dashboard'),actual=data.meetings.find(m=>m.id===owned.id);
  if(!actual||actual.sourceMailId!==owned.sourceMailId||actual.title!==owned.title||actual.startMs!==owned.startMs)throw blocked('本轮测试会议身份已变化，未取消其他提醒');
  if(actual.reminder){
   if(![owned.beforeLead,owned.lastLead,owned.proposedLead].includes(actual.reminder.leadMinutes))throw blocked('本轮测试提醒被其他操作修改，保留现场');
   await call('/meetings/'+encodeURIComponent(owned.id)+'/reminder',{method:'POST',body:{cancel:true}});
   if((await call('/dashboard')).meetings.find(m=>m.id===owned.id)?.reminder)throw blocked('本轮专用测试提醒取消未确认');
  }
  const alert=page.getByRole('alert').filter({has:page.getByText(owned.title,{exact:true})});
  if(await alert.count()===1){await alert.getByRole('button',{name:/关闭/}).click();await alert.waitFor({state:'hidden'});}
  delete mail.reminder;
 }
 if(mail.draftPending){
  const frame=page.locator('iframe[data-widget-id="'+mail.widgetId+'"]').filter({visible:true}).contentFrame();
  if(await frame.locator('#d-draft').isDisabled())throw blocked('邮件AI草稿仍在生成，保留原详情等待终态');
  delete mail.draftPending;
 }
}
