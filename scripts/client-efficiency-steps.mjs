import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {prepare} from './client-kanban-steps.mjs';
import {diskScanCode,timerSeconds,timerProgress,naturalWeek,systemDisks,diskChecks,diskFormat} from './mobilework-efficiency.mjs';

const save=(c,name,value)=>fs.writeFile(path.join(c.dir,name+'.json'),JSON.stringify(value,null,2));
const blocked=message=>Object.assign(Error(message),{blocked:true});
const hash=text=>createHash('sha256').update(text).digest('hex');
const pause=async(c,ms)=>{await c.page.waitForTimeout(ms);await c.checkpointResources();};
async function until(c,read,ready,message,timeout=30000){
 const end=Date.now()+timeout;let value;do{value=await read();if(ready(value))return value;await pause(c,250);}while(Date.now()<end);throw blocked(message);
}
async function fixture(context,prepared,title){
 const {call,canvas,before}=prepared,matches=[];
 for(const board of before.filter(b=>b.title==='效率工具'))for(const placement of (await call('/canvases/'+board.canvasId)).placements){const widget=await call('/widgets/'+placement.widgetId);if(widget.title===title)matches.push({board,widget,source:await call('/widgets/'+widget.widgetId+'/page')});}
 if(matches.length!==1)throw blocked('真实效率工具组件不唯一：'+title);
 const original=matches[0],owned=context.resources.kanban;owned.widgetTitle=owned.title.replace('Kanban','Widget');
 let automation;
 if(title==='硬盘剩余空间'){
  const links=(await call('/bindings')).items.filter(b=>b.widgetId===original.widget.widgetId);context.assert('原磁盘组件只有一个真实数据绑定',links.length===1);const sourceAutomation=(await call('/automations')).items.find(a=>a.automationId===links[0].automationId),code=await call('/automations/'+sourceAutomation.automationId+'/code');
  context.assert('仅复制已核对的产品只读磁盘扫描代码',code.content===diskScanCode&&sourceAutomation.trigger.kind==='manual'&&sourceAutomation.execution.runtime==='python');
  owned.refresh={kind:'disk',title:owned.title+'-刷新',beforeIds:(await call('/automations')).items.map(a=>a.automationId),submitted:true,automationId:null,widgetId:null,bindingId:null};await context.checkpointResources();
  const created=await call('/automations',{method:'POST',body:{title:owned.refresh.title,description:'MobileWork自动化测试只读磁盘扫描，仅服务于本轮隔离组件。',trigger:{kind:'manual'},input:sourceAutomation.input,execution:sourceAutomation.execution,result:sourceAutomation.result}});automation=created.automation;owned.refresh.automationId=automation.automationId;await context.checkpointResources();await call('/automations/'+automation.automationId+'/code',{method:'PUT',body:{content:diskScanCode}});
 }else context.assert('计时与打卡原组件不带执行事件',!original.widget.events?.submit);
 owned.widgetPending=true;await context.checkpointResources();const widget=await call('/widgets',{method:'POST',body:{title:owned.widgetTitle,...(automation?{slots:original.widget.slots}:{})}});owned.widgetIds=[widget.widgetId];await context.checkpointResources();
 await call('/widgets/'+widget.widgetId+'/page',{method:'PUT',body:{html:original.source.html}});
 if(automation){owned.refresh.widgetId=widget.widgetId;await context.checkpointResources();await call('/widgets/'+widget.widgetId,{method:'PATCH',body:{events:original.widget.events}});const binding=await call('/bindings',{method:'POST',body:{automationId:automation.automationId,widgetId:widget.widgetId}});owned.refresh.bindingId=binding.bindingId;await context.checkpointResources();}
 await call('/canvases/'+canvas.canvasId+'/placements',{method:'POST',body:{widgetId:widget.widgetId,layout:{mode:'grid',x:0,y:0,w:12,h:20}}});owned.widgetPending=false;await context.checkpointResources();
 await context.page.getByRole('button',{name:'刷新',exact:true}).filter({visible:true}).click();const frame=context.page.locator('iframe[data-widget-id="'+widget.widgetId+'"]').contentFrame();await frame.locator('body').waitFor();
 context.assert('隔离组件与真实产品HTML字节相同',hash((await call('/widgets/'+widget.widgetId+'/page')).html)===hash(original.source.html));await save(context,'效率工具隔离材料来源',{originalCanvasId:original.board.canvasId,originalWidgetId:original.widget.widgetId,htmlSha256:hash(original.source.html),widgetId:widget.widgetId,canvasId:canvas.canvasId,...(automation?{automationId:automation.automationId,codeSha256:hash(diskScanCode)}:{}),source:'按真实产品原样复制的预存隔离组件；未复制用户viewState、未改计时或预置业务结果'});context.remaining.delete('原样产品组件与独立状态材料');return {call,canvas,frame,widget};
}
async function timer(context,{frame}){
 const read=async()=>({seconds:timerSeconds(await frame.locator('#time').innerText()),at:Date.now()}),samples=[];
 for(const [mode,total] of [['focus',1500],['short',300],['long',900]]){
  await frame.locator('[data-mode="'+mode+'"]').click();context.assert('真实模式初始时长：'+mode,(await read()).seconds===total);
  await frame.locator('#btn-start').click();const before=await read();await pause(context,2500);const running=await read();context.assert('真实时钟倒计时：'+mode,timerProgress(before.seconds,running.seconds,running.at-before.at));
  await frame.locator('#btn-start').click();const paused=await read();await pause(context,2000);const held=await read();context.assert('暂停保持时间与按钮：'+mode,held.seconds===paused.seconds&&await frame.locator('#btn-start').innerText()==='继续');
  await frame.locator('#btn-start').click();await pause(context,2000);const resumed=await read();context.assert('继续不重置且真实倒计时：'+mode,resumed.seconds<held.seconds&&resumed.seconds<total);
  await frame.locator('#btn-reset').click();context.assert('真实重置回初始且准备开始：'+mode,(await read()).seconds===total&&await frame.locator('#status').innerText()==='准备开始');samples.push({mode,total,before,running,paused,held,resumed});await context.capture('番茄钟-'+mode+'暂停继续重置');
 }
 context.remaining.delete('专注短休长休计时暂停继续与重置');await save(context,'真实三模式计时时间线',samples);
 await frame.locator('[data-mode="focus"]').click();const rounds=Number(await frame.locator('#stat-rounds').innerText()),minutes=Number(await frame.locator('#stat-minutes').innerText());await frame.locator('#btn-start').click();const started=Date.now(),timeline=[];
 // Complete a genuine 25 minute round. Clock/state injection or shortening the
 // product duration would test a different feature and is deliberately absent.
 while(Number(await frame.locator('#stat-rounds').innerText())===rounds){
  if(Date.now()-started>1530000)throw blocked('真实25分钟专注尚未正常完成，保留时间线');
  if(!timeline.length||Date.now()-timeline.at(-1).at>=60000){timeline.push({...await read()});await save(context,'真实完整专注轮次时间线',{started,timeline});}
  await pause(context,1000);
 }
 context.assert('真实完整专注轮次及分钟累计',Date.now()-started>=1498000&&Number(await frame.locator('#stat-rounds').innerText())===rounds+1&&Number(await frame.locator('#stat-minutes').innerText())===minutes+25);await context.capture('完整专注轮次真实统计');context.remaining.delete('真实25分钟完成及今日统计累计');
}
async function disk(context,{call,frame,widget}){
 const owned=context.resources.kanban;let previousRunId;
 for(let attempt=1;attempt<=2;attempt++){
  const before=await systemDisks();const [response]=await Promise.all([context.page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/blueprint/widgets/'+widget.widgetId+'/emit'),frame.locator('#rescan').click()]);context.assert('磁盘重新扫描真实触发当前独立绑定',response.ok());const emitted=await response.json();context.assert('扫描任务确为本轮automation/binding',emitted.automationId===owned.refresh.automationId&&emitted.bindingId===owned.refresh.bindingId);
  context.assert('每次手动重新扫描创建独立真实运行',typeof emitted.runId==='string'&&emitted.runId!==previousRunId);previousRunId=emitted.runId;
  const route='/automations/'+emitted.automationId+'/runs/'+emitted.runId,run=await until(context,()=>call(route),r=>!['queued','running'].includes(r.status),'磁盘真实扫描未终态',60000);await save(context,'磁盘实际运行终态-'+attempt,{emitted,run,before});context.assert('磁盘只读扫描真实执行成功',run.status==='succeeded');const artifact=await call(route+'/artifact'),data=JSON.parse(artifact.content),after=await systemDisks(),facts=diskChecks(data,before,after);context.assert('本机磁盘全集与独立系统观察一致',data.system==='Windows'&&facts.allDrives&&data.drives.length>0);
  for(const fact of facts.drives)context.assert('独立系统容量可用空间及占比：'+fact.drive,fact.capacity&&fact.arithmetic&&fact.free);
  const delivered=await until(context,()=>frame.locator('body').evaluate(()=>({data:window.DaimonWidget.data.main,lastRun:window.DaimonWidget.lastRun})),value=>value.lastRun?.runId===emitted.runId&&JSON.stringify(value.data)===JSON.stringify(data),'本轮扫描产物尚未通过宿主数据桥更新');
  context.assert('本轮实际数据桥包含完整磁盘集合',delivered.data.drives.length===data.drives.length);
  for(const item of data.drives){const row=frame.locator('#list .disk').filter({has:frame.getByText(item.drive,{exact:true})}),text=await row.innerText();context.assert('真实磁盘卡片完整数据：'+item.drive,text.includes(diskFormat(item.free))&&text.includes(diskFormat(item.total))&&text.includes(item.used_pct+'% 已用'));}
  context.assert('总容量及已使用汇总回显',await frame.locator('#total').innerText()===diskFormat(data.drives.reduce((s,d)=>s+d.total,0))&&await frame.locator('#used').innerText()===diskFormat(data.drives.reduce((s,d)=>s+d.used,0)));await frame.locator('#rescan').filter({hasText:'重新扫描'}).waitFor();await save(context,'磁盘实际扫描-'+attempt,{runId:emitted.runId,data,before,after,facts});await context.capture('磁盘扫描-'+attempt+'与系统真实值');
 }
 context.remaining.delete('真实磁盘扫描数据与独立系统核对');context.remaining.delete('手工重扫新运行及实际更新');
}
async function habits(context,{frame}){
 const text='MW-待办-'+randomUUID().slice(0,8);await frame.locator('#todo-input').fill(text);await frame.locator('#todo-add').click();const row=frame.locator('#todo-list .todo-item').filter({has:frame.getByText(text,{exact:true})});await row.waitFor();context.assert('真实新增待办默认未完成',await row.locator('.circle.checked').count()===0);await row.locator('.circle').click();context.assert('真实勾选待办更新完成文本及标记',await row.locator('.circle.checked').count()===1&&await row.locator('.todo-text.done').innerText()===text);context.remaining.delete('真实待办添加及完成与统计');
 const calendar=naturalWeek(),names=['喝水','运动'];
 for(const name of names){const habit=frame.locator('#habit-list .habit-row').filter({has:frame.locator('.name').getByText(name,{exact:true})}),cell=habit.locator('.habit-cell[data-i="'+calendar.todayIndex+'"]');if(await cell.evaluate(n=>n.classList.contains('checked')))await cell.click();context.assert('当日打卡前真实未勾选：'+name,!await cell.evaluate(n=>n.classList.contains('checked')));await cell.click();context.assert('实际当日打卡标记：'+name,await cell.evaluate(n=>n.classList.contains('checked'))&&await cell.innerText()==='✓');}
 context.assert('周视图为周一至周日且当天标记正确',JSON.stringify(await frame.locator('#habit-head .day').allTextContents())===JSON.stringify(['一','二','三','四','五','六','日'])&&await frame.locator('#week').innerText()===calendar.week&&await frame.locator('#habit-head .day.today').innerText()===['一','二','三','四','五','六','日'][calendar.todayIndex]);
 const state=await frame.locator('body').evaluate(()=>window.DaimonCanvas.viewState);for(const name of names){const habit=state.habits.find(h=>h.name===name);context.assert('打卡真实写入当日自然周日期：'+name,habit.checks[calendar.dates[calendar.todayIndex]]===true);}
 const done=state.todos.filter(t=>t.done).length;context.assert('待办统计来自完整实际清单',await frame.locator('#todo-count').innerText()===done+'/'+state.todos.length);
 let checked=0;for(const h of state.habits)for(const date of calendar.dates.slice(0,calendar.todayIndex+1))if(h.checks[date])checked++;const rate=Math.round(checked/(state.habits.length*(calendar.todayIndex+1))*100);context.assert('本周打卡完成率与真实清单日期一致',await frame.locator('#rate').innerText()===rate+'%');await context.capture('真实待办完成及本周习惯打卡');
 await context.page.getByRole('button',{name:'刷新',exact:true}).filter({visible:true}).click();await row.locator('.circle.checked').waitFor();for(const name of names){const habit=frame.locator('#habit-list .habit-row').filter({has:frame.getByText(name,{exact:true})});await habit.locator('.habit-cell.checked[data-i="'+calendar.todayIndex+'"]').waitFor();}await save(context,'打卡真实状态及自然周',{calendar,state,rate});context.remaining.delete('当日习惯打卡自然周视图及持久回读');
}
export async function runEfficiencySteps(context){
 const prepared=await prepare(context),title={162:'番茄钟',163:'硬盘剩余空间',164:'待办打卡'}[context.number],material=await fixture(context,prepared,title);
 if(context.number===162)await timer(context,material);else if(context.number===163)await disk(context,material);else await habits(context,material);
}
