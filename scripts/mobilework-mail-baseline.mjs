import fs from 'node:fs/promises';

export const beijingDate=value=>new Date(value).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
export function validateMailBaseline(value,now=Date.now()){
 if(value.source!=='external-test-mailbox'||beijingDate(value.observedAt)!==beijingDate(now)||!Array.isArray(value.messages)||new Set(value.messages.map(item=>item.id)).size!==value.messages.length)throw Error('邮箱基线必须为当天独立测试邮箱记录且邮件ID唯一');
 for(const key of ['receivedToday','pending','handledThisWeek'])if(!Number.isInteger(value.summary?.[key])||value.summary[key]<0)throw Error('邮箱基线缺少真实计数：'+key);
 for(const mail of value.messages){
  if(typeof mail.id!=='string'||typeof mail.title!=='string'||!['high','medium','low'].includes(mail.priority)||typeof mail.disposable!=='boolean'||!mail.receivedAt||!mail.status)throw Error('测试邮件基线字段无效');
 }
 if(value.history){
  const h=value.history;
  if(h.complete!==true||!Number.isFinite(h.fromMs)||!Number.isFinite(h.throughMs)||h.fromMs>h.throughMs||!Array.isArray(h.records)||new Set(h.records.map(m=>m.id)).size!==h.records.length)throw Error('邮箱历史基线必须为有明确时间范围的完整唯一记录');
  for(const mail of h.records)if(typeof mail.id!=='string'||!Number.isFinite(mail.timeMs)||mail.handledAt!==undefined&&!Number.isFinite(mail.handledAt)||typeof mail.title!=='string')throw Error('邮箱历史记录字段无效');
 }
 if(value.send&&(value.send.authorized!==true||!value.send.name||!value.send.recipient||beijingDate(value.send.confirmedAt)!==beijingDate(now)))throw Error('发信授权须明确专用收件人并在当天确认');
 if(value.meetings)for(const m of value.meetings)if(!m.id||!m.sourceMailId||!m.title||!Number.isFinite(m.startMs)||typeof m.disposable!=='boolean'||!m.online?.app||!m.online?.url||!m.online?.meetingNo||m.testReminder===true&&!m.title.startsWith('MW-Autotest-Meeting-'))throw Error('会议基线缺少独立来源和会议字段或专用标题');
 return value;
}
export async function readMailBaseline(){
 const file=process.env.MW_TEST_MAIL_BASELINE;
 return file?validateMailBaseline(JSON.parse(await fs.readFile(file,'utf8'))):null;
}
export function disposablePendingMail(baseline,todos){
 return baseline?.messages.find(item=>item.disposable&&todos.some(todo=>todo.id===item.id&&todo.title===item.title))||null;
}
export function priorityForFacts(mail,now=Date.now()){
 if(!mail.actionable)return 'low';
 if(mail.asap||mail.deadlineMs!==undefined&&mail.deadlineMs<=new Date(beijingDate(now)+'T23:59:59.999+08:00').getTime())return 'high';
 return 'medium';
}
