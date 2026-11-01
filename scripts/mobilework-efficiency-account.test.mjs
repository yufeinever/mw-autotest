import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {timerSeconds,timerProgress,naturalWeek,diskChecks,diskFormat,systemDisks,diskScanCode} from './mobilework-efficiency.mjs';
import {releaseKanbanOperations,finishKanbanRefresh,kanbanRefreshCode} from './mobilework-kanban-operation-resources.mjs';
import {validateKanbanOwnership} from './mobilework-kanban.mjs';
import {TaskControl} from './mobilework-task-control.mjs';
import {readAccountSnapshot,closeAccountMenu,balanceText,accountUsageFacts,billingDelta} from './mobilework-account-menu.mjs';
import {runAccountUsageSteps} from './client-account-usage-steps.mjs';
import {clientCases,getClientCase} from './client-case-catalog.mjs';
import {withClientCases} from '../local-console/case-registry.mjs';

test('效率工具独立事实：真实Windows磁盘、倒计时误差及跨年自然周边界',async()=>{
 assert.equal(timerSeconds('25:00'),1500);assert.equal(timerSeconds('05:00'),300);assert.equal(timerSeconds('15:00'),900);assert.throws(()=>timerSeconds('12:60'),/格式/);
 assert.ok(timerProgress(1500,1497,2500));assert.ok(!timerProgress(1500,1500,2500));assert.ok(!timerProgress(1500,1490,2500));
 assert.deepEqual(naturalWeek(new Date(2021,0,1)),{dates:['2020-12-28','2020-12-29','2020-12-30','2020-12-31','2021-01-01','2021-01-02','2021-01-03'],todayIndex:4,week:'2020-W53'});
 assert.equal(naturalWeek(new Date(2026,10,1)).week,'2026-W44');assert.equal(naturalWeek(new Date(2026,10,2)).week,'2026-W45');
 const real=await systemDisks();assert.ok(real.length>0);for(const d of real){assert.match(d.drive,/^[A-Z]:$/);assert.ok(d.total>0&&d.free>=0&&d.free<=d.total);}
 const total=100*1024**3,before=[{drive:'C:',total,free:40*1024**3}],after=[{...before[0],free:before[0].free-1024**2}],disk={drive:'C:',total,free:before[0].free,used:60*1024**3,used_pct:60};
 let result=diskChecks({drives:[disk]},before,after);assert.ok(result.allDrives&&Object.values(result.drives[0]).every(Boolean));
 assert.equal(diskChecks({drives:[]},before,after).allDrives,false);assert.equal(diskChecks({drives:[{...disk,used_pct:61}]},before,after).drives[0].arithmetic,false);
 assert.equal(diskChecks({drives:[{...disk,free:disk.free+128*1024**2}]},before,after).drives[0].free,false);assert.equal(diskFormat(1024**4),'1.0 TB');
});

test('新磁盘与原152刷新收尾按类型核对代码、拒绝跨资源绑定并停止本轮运行',async()=>{
 const title='MW-Autotest-Kanban-163-01234567',owned={title,widgetTitle:title.replace('Kanban','Widget'),beforeIds:['user-board'],beforeWidgetIds:['user-widget'],submitted:true,id:'own-board',pendingAdd:false,removing:false,widgetIds:['own-widget'],refresh:{kind:'disk',title:title+'-刷新',beforeIds:['user-automation'],submitted:true,automationId:'own-automation',widgetId:'own-widget',bindingId:'own-binding'}};
 validateKanbanOwnership(owned);assert.throws(()=>validateKanbanOwnership({...owned,refresh:{...owned.refresh,kind:undefined}},owned),/不能替换/);
 let code=diskScanCode,foreign=false,running=true,removed=false,binding=true;const writes=[];
 const call=async(route,{method='GET'}={})=>{
  if(method!=='GET')writes.push([method,route]);
  if(route==='/automations')return {items:[{automationId:'user-automation'},...removed?[]:[{automationId:'own-automation',title:title+'-刷新',trigger:{kind:'manual'},execution:{kind:'code',runtime:'python'}}]]};
  if(route==='/automations/own-automation/code')return {content:code};
  if(route==='/bindings')return {items:binding?[{bindingId:'own-binding',automationId:'own-automation',widgetId:foreign?'user-widget':'own-widget'}]:[]};
  if(route==='/automations/own-automation/runs')return {items:[{status:running?'running':'cancelled'}]};
  if(route==='/automations/own-automation/cancel'){running=false;return {};}
  if(route==='/automations/own-automation'&&method==='DELETE'){assert.equal(running,false);removed=true;return {};}
  throw Error('越界访问 '+route);
 };
 const page={waitForTimeout:async()=>{}};
 code=kanbanRefreshCode;await assert.rejects(releaseKanbanOperations(page,structuredClone(owned),call),/代码已变化/);assert.equal(running,true);
 code=diskScanCode;foreign=true;await assert.rejects(releaseKanbanOperations(page,structuredClone(owned),call),/其他资源引用/);assert.equal(running,true);
 foreign=false;await releaseKanbanOperations(page,owned,call);assert.equal(running,false);await assert.rejects(finishKanbanRefresh(owned,call),/仍有绑定/);assert.equal(removed,false);
 binding=false;await finishKanbanRefresh(owned,call);assert.equal(removed,true);assert.equal(owned.refresh,undefined);assert.ok(writes.every(([,route])=>!route.includes('user')));
 // The shared cleanup also retains the original stamp-code contract for 152.
 removed=false;running=false;binding=false;code=kanbanRefreshCode;const old=structuredClone(owned);old.refresh={title:title+'-刷新',beforeIds:['user-automation'],submitted:true,automationId:'own-automation',widgetId:null,bindingId:null};await releaseKanbanOperations(page,old,call);assert.equal(old.refresh.automationId,'own-automation');
});

function accountContext({before=1000000,after=999000,dir}={}){
 const control=new TaskControl({url:'http://test.invalid',token:'synthetic-test-token'}),state={balance:before,visible:false,menuToken:null,sends:0,events:[]};
 const held=()=>assert.equal(control.held,true,'界面读写必须持有UI');
 control.acquire=async()=>{assert.equal(control.held,false);control.held=true;state.events.push('acquire');};
 control.release=async()=>{held();state.events.push('release');control.held=false;};control.focus=async()=>{held();state.events.push('focus');};
 const amount={waitFor:async()=>held(),innerText:async()=>{held();return balanceText(state.balance);}};
 const row={filter:()=>row,getByText:()=>amount};
 const menu={filter:()=>menu,count:async()=>{held();return Number(state.visible);},waitFor:async options=>{held();if(options?.state==='hidden')assert.equal(state.visible,false);else assert.equal(state.visible,true);},evaluate:async(fn,token)=>{held();state.menuToken=token;},getByRole:()=>row,press:async key=>{held();assert.equal(key,'Escape');state.visible=false;state.events.push('close');}};
 const page={getByRole:()=>menu,evaluate:async()=>{held();return {ok:true,balance:state.balance};},locator:selector=>{
  if(selector.startsWith('[data-mw-account-menu='))return {...menu,isVisible:async()=>{held();return state.visible&&selector.includes(state.menuToken);}};
  return {click:async()=>{held();state.visible=true;state.events.push('open');},innerText:async()=>{held();return '合成测试账户';}};
 }};
 const completed=Date.now()-1000,context={number:166,page,control,dir,resources:{},remaining:new Set(['真实账户菜单余额及独立云端对照','独立自动模型任务及真实Token消耗','无手工刷新自动同步及独立账单扣量']),assert:(name,pass)=>assert.ok(pass,name),checkpointResources:async()=>{held();state.events.push('checkpoint');},capture:async()=>control.withUI(page,'EVIDENCE',async()=>held()),send:async()=>{assert.equal(state.visible,false);state.sends++;state.balance=after;control.sessionId='ses_synthetic';},getSessionId:()=> 'ses_synthetic',getData:()=>({messages:[{info:{role:'assistant',time:{completed},tokens:{input:5,output:5,reasoning:0}},parts:[]}]})};
 return {context,state,identity:createHash('sha256').update('合成测试账户').digest('hex'),completed};
}

test('账户菜单在模型后重新获取UI，截图不提前释放，未知菜单不自动关闭',async()=>{
 const {context,state}=accountContext();context.control.sessionId='ses_synthetic';
 const value=await readAccountSnapshot(context,'执行后');assert.equal(value.balance,1000000);assert.equal(context.control.held,false);assert.equal(context.resources.accountMenuToken,undefined);assert.equal(state.visible,false);
 assert.deepEqual(state.events.filter(x=>['acquire','focus','open','close','release'].includes(x)),['acquire','focus','open','close','release']);
 state.visible=true;await assert.rejects(readAccountSnapshot(context,'未知菜单'),/非本轮菜单/);assert.equal(state.visible,true);assert.equal(context.resources.accountMenuToken,undefined);
 await context.control.acquire();const resources={accountMenuToken:'another-token'};await assert.rejects(closeAccountMenu(context.page,resources),/保留现场/);assert.equal(resources.accountMenuToken,'another-token');assert.equal(state.visible,true);await context.control.release();
});

test('独立云端账单与实际扣量，零余额可查看，显示精度不足保留REVIEW且不重发',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-account-')),file=path.join(dir,'synthetic-facts.json'),previous=process.env.MW_TEST_ACCOUNT_USAGE_FACTS;
 process.env.MW_TEST_ACCOUNT_USAGE_FACTS=file;
 try{
  const {context,state,identity,completed}=accountContext({before:1000000,after:999999,dir});
  const entry={sessionId:'ses_synthetic',balanceBefore:1000000,balanceAfter:999999,chargedTokens:1,requestIds:['synthetic-request'],settledAt:new Date(completed+500).toISOString()},fact={source:'external-account-billing',observedAt:new Date().toISOString(),accountLabelSha256:identity,balance:999999,sessions:[entry]};
  await fs.writeFile(file,JSON.stringify(fact));assert.ok(billingDelta(1000000,999999,entry));assert.ok(!billingDelta(1000000,999999,{...entry,requestIds:[]}));assert.ok(!billingDelta(1000000,999000,entry));
  await assert.rejects(accountUsageFacts('other-account'),/身份/);await assert.rejects(accountUsageFacts(identity,Date.now()+600001),/时效/);
  await assert.rejects(runAccountUsageSteps(context),error=>error.review&&/显示精度/.test(error.message));assert.equal(state.sends,1);assert.equal(state.visible,false);assert.ok(context.remaining.has('无手工刷新自动同步及独立账单扣量'));
  const zero=accountContext({before:0,after:0,dir});zero.context.number=165;await fs.writeFile(file,JSON.stringify({...fact,balance:0,sessions:[]}));await runAccountUsageSteps(zero.context);assert.equal(zero.state.sends,0);assert.ok(!zero.context.remaining.has('真实账户菜单余额及独立云端对照'));
 }finally{
  if(previous===undefined)delete process.env.MW_TEST_ACCOUNT_USAGE_FACTS;else process.env.MW_TEST_ACCOUNT_USAGE_FACTS=previous;
  await fs.rm(dir,{recursive:true,force:true});
 }
});

test('001～166正式入口与原表对应，迁移保留用户ID、名称及自定义脚本',async()=>{
 const root=path.resolve('.');assert.ok(clientCases.length>=166);
 for(const item of clientCases){assert.equal(item.row,item.number+1);await fs.access(item.entry);}
 for(let number=162;number<=166;number++)assert.match(getClientCase(number).kind,/^interaction-/);
 const old=[{id:'existing-2',name:'用户会议名',path:path.resolve(getClientCase(2).entry)},{id:'custom',name:'用户脚本',path:path.resolve('other.mjs')}],migrated=withClientCases(old,root);
 assert.equal(migrated.length,clientCases.length+43);assert.deepEqual(migrated.slice(0,2).map(({id,name,path})=>({id,name,path})),old);assert.deepEqual(withClientCases(migrated,root),migrated);
});
