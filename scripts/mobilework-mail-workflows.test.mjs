import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMailBaseline} from './mobilework-mail-baseline.mjs';
import {weekStart,weeklyFacts,contactFacts,completeMailHistory,authorizedTestRecipient,disposableReminder,releaseMailOperations,sentMatches} from './mobilework-mail-operations.mjs';
import {validateKanbanOperations} from './mobilework-kanban-operation-resources.mjs';
import {validateWeatherBaseline,weatherChecks,windDisplay} from './mobilework-weather-baseline.mjs';

const now=Date.parse('2026-11-01T12:00:00+08:00'),day=86400000,root={source:'external-test-mailbox',observedAt:'2026-11-01T12:00:00+08:00',summary:{receivedToday:0,pending:0,handledThisWeek:0},messages:[]};
const noAlert={getByText:()=>({}),getByRole:()=>({filter:()=>({count:async()=>0})})};
test('周收件与处理独立跨周分桶、联系人7天规则及完整历史边界',()=>{
 const start=Date.parse('2026-10-26T00:00:00+08:00');assert.equal(weekStart(now),start);assert.equal(weekStart(start-1),start-7*day);
 const history={complete:true,fromMs:now-31*day,throughMs:now,records:[
  {id:'a',title:'上周收本周办',timeMs:start-1,handledAt:start,senderName:'甲',senderEmail:'a@example.invalid'},
  {id:'b',title:'更旧历史本周办',timeMs:start-14*day,handledAt:start+1000,senderName:'甲',senderEmail:'a@example.invalid'},
  {id:'c',title:'本周新收',timeMs:now-1,senderName:'乙',senderEmail:'b@example.invalid'},
  {id:'d',title:'七天窗外',timeMs:now-8*day,senderName:'丙',senderEmail:'c@example.invalid'}
 ]};
 assert.deepEqual(weeklyFacts(history,now).at(-1),{from:start,to:start+7*day,received:1,handled:2});
 assert.deepEqual(contactFacts(history,now).map(m=>[m.name,m.count]),[['乙',1],['甲',1]]);assert.equal(contactFacts(history,now,{days:30,top:8})[0].name,'甲');
 assert.equal(completeMailHistory({...root,history},now-30*day,now),history);assert.equal(completeMailHistory({...root,history},now-32*day,now),null);assert.equal(completeMailHistory(root,now-day,now),null);
 validateMailBaseline({...root,history},now);assert.throws(()=>validateMailBaseline({...root,history:{...history,records:[history.records[0],history.records[0]]}},now),/唯一/);
 const send={authorized:true,confirmedAt:root.observedAt,name:'测试',recipient:'test@example.invalid'};assert.equal(authorizedTestRecipient({...root,send},[{name:'用户',email:send.recipient}],now),null);assert.equal(authorizedTestRecipient({...root,send},[{name:send.name,email:send.recipient}],now),send);
});
test('未决发信不重试且保留归属，唯一新记录才能释放，旧及异收件记录不冒认',async()=>{
 const send={beforeIds:['old'],subject:'MW-Autotest-Mail-160-unique',recipient:'test@example.invalid',marker:'synthetic-marker',startedAt:now},mail={widgetId:'widget_old',modals:['compose'],send},requests=[];
 const sent={id:'new',title:send.subject,recipient:send.recipient,timeMs:now};
 const client=async()=>async(route,options)=>{requests.push([route,options]);return {sentMail:[]};};
 await assert.rejects(releaseMailOperations(noAlert,mail,{client}),/未唯一确认/);assert.equal(mail.send,send);assert.deepEqual(requests,[['/dashboard',undefined]]);
 assert.equal(sentMatches([{...sent,id:'old'},{...sent,recipient:'other@example.invalid'},{...sent,timeMs:now-1}],send).length,0);
 await releaseMailOperations(noAlert,mail,{client:async()=>async()=>({sentMail:[sent]})});assert.equal(mail.send,undefined);
 const parent={beforeWidgetIds:['widget_old'],mail:{widgetId:'widget_old',modals:['compose'],send}};validateKanbanOperations(parent);assert.throws(()=>validateKanbanOperations({...parent,mail:{...parent.mail,send:{...send,recipient:'other@example.invalid'}}},parent),/不能替换/);
});
test('提醒只匹配专用未触发会议，恢复不取消其他会议，AI起草未终态不关框',async()=>{
 const fact={id:'meeting_test',sourceMailId:'mail_test',title:'MW-Autotest-Meeting-unique',startMs:now+45*60000,online:{app:'测试会议',url:'https://example.invalid/meeting',meetingNo:'123'},disposable:true,testReminder:true};
 const meeting={...fact,reminder:{leadMinutes:5}},baseline={...root,meetings:[fact]};validateMailBaseline(baseline,now);assert.equal(disposableReminder(baseline,[meeting],now).actual,meeting);assert.equal(disposableReminder(baseline,[{...meeting,reminder:{leadMinutes:5,firedAt:now}}],now),null);
 const owned={id:fact.id,sourceMailId:fact.sourceMailId,title:fact.title,startMs:fact.startMs,disposable:true,beforeLead:5,lastLead:15,proposedLead:30},mail={reminder:owned},calls=[];
 await assert.rejects(releaseMailOperations(noAlert,mail,{client:async()=>async()=>({meetings:[{...meeting,title:'其他会议'}]})}),/身份已变化/);assert.equal(mail.reminder,owned);
 let cancelled=false;await releaseMailOperations(noAlert,mail,{client:async()=>async(route,options)=>{calls.push([route,options]);if(options){assert.equal(route,'/meetings/meeting_test/reminder');assert.deepEqual(options.body,{cancel:true});cancelled=true;return {ok:true};}return {meetings:[{...meeting,reminder:cancelled?undefined:{leadMinutes:30}}]};}});assert.equal(mail.reminder,undefined);assert.equal(calls.filter(([,o])=>o).length,1);
 const pending={widgetId:'widget_old',draftPending:true};const page={locator:()=>({filter:()=>({contentFrame:()=>({locator:()=>({isDisabled:async()=>true})})})})};await assert.rejects(releaseMailOperations(page,pending,{client:async()=>async()=>{throw Error('不能发起无关请求');}}),/仍在生成/);assert.equal(pending.draftPending,true);
});
test('天气独立来源时效与误差边界、圆周风向和风力换算',()=>{
 const fact={source:'independent-weather-observation',provider:'测试独立气象站',city:'测试城',latitude:30,longitude:120,observedAt:root.observedAt,temperature:20,minimum:10,maximum:25,humidity:60,windSpeed:10,windDirection:355,tolerance:{temperature:2,humidity:5,windSpeed:3,windDirection:15}};
 validateWeatherBaseline(fact,now);assert.throws(()=>validateWeatherBaseline({...fact,provider:'Open-Meteo'},now),/独立/);assert.throws(()=>validateWeatherBaseline(fact,now+3600001),/一小时/);
 const data={current:{temperature_2m:22,relative_humidity_2m:65,wind_speed_10m:13,wind_direction_10m:5},daily:{temperature_2m_min:[8],temperature_2m_max:[27]}};assert.ok(Object.values(weatherChecks(data,fact)).every(Boolean));data.current.temperature_2m=22.1;data.current.wind_direction_10m=30;assert.equal(weatherChecks(data,fact).temperature,false);assert.equal(weatherChecks(data,fact).windDirection,false);assert.equal(windDisplay(12,359),'北风3级');assert.equal(windDisplay(0,90),'东风0级');
});
