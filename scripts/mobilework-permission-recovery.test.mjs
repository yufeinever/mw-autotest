import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {clickApproval,handleConfiguredDialog} from './mobilework-run-policy.mjs';
import {PermissionEvents} from './mobilework-permission-events.mjs';
import {TaskControl} from './mobilework-task-control.mjs';
import {cancelApprovalConsent,settleStoppedConsent} from '../local-console/stop-job.mjs';

test('审批接口400时仅信任有基线且连续的空事件快照',async()=>{
 const ledger=new PermissionEvents({connection:{},sessionId:'ses_Mine',directory:'D:/isolated'});
 const control=new TaskControl({url:'unused',token:'isolated'});
 control.sessionId='ses_Mine';control.permissionEvents=ledger;
 control.get=async route=>{if(route==='/question')return [];throw Object.assign(Error('HTTP 400'),{patchPermissionError:true});};
 ledger.accept({type:'server.connected'});
 await assert.rejects(()=>control.pendingInteractions(),/HTTP 400/);
 ledger.seed([{id:'per_A',sessionID:'ses_Mine'}],ledger.checkpoint());
 ledger.accept({type:'permission.replied',properties:{sessionID:'ses_Mine',requestID:'per_A'}});
 const pending=await control.pendingInteractions();
 assert.equal(pending.length,0);assert.equal(pending.permissionApiUnavailable,true);
 ledger.stop();
 await assert.rejects(()=>control.pendingInteractions(),/HTTP 400/);
});

test('完全访问确认消失且审批接口400时，强停对应根会话后才释放',async()=>{
 let stopped=false;const checkpoints=[];
 const server=http.createServer((request,response)=>{
  const route=new URL(request.url,'http://localhost').pathname;
  response.setHeader('content-type','application/json');
  if(route==='/session/ses_Mine')return response.end(JSON.stringify({id:'ses_Mine',directory:'D:/isolated'}));
  if(route==='/session/status')return response.end(JSON.stringify(stopped?{}:{ses_Mine:{type:'busy'}}));
  if(route==='/permission'){response.statusCode=400;return response.end(JSON.stringify({data:{message:'Expected JSON value filePath patch'}}));}
  if(route==='/question')return response.end('[]');
  if(route==='/session/ses_Mine/abort'){stopped=true;return response.end('true');}
  response.statusCode=404;response.end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage();await page.goto('about:blank#/workspace/a/session/ses_Mine');
  const owned={url:page.url(),sessionId:'ses_Mine',directory:'D:/isolated',id:'per_A',phase:'confirming',rootKey:'A'};
  const root={key:'A',id:owned.sessionId,url:owned.url,directory:owned.directory,modelCompleted:false,sessionSettled:false};
  const job={rootSessions:[root]},connection={baseUrl:'http://127.0.0.1:'+server.address().port,opencodeUsername:'fixture',opencodePassword:'synthetic'};
  await cancelApprovalConsent(page,owned,{resolved:()=>settleStoppedConsent(page,job,owned,connection,async()=>{checkpoints.push({...root});})});
  assert.equal(stopped,true);assert.equal(root.abortAcknowledged,true);assert.equal(root.sessionSettled,true);assert.equal(checkpoints.length,3);
  assert.equal(checkpoints[0].recoveryAbortAttempted,true);assert.equal(checkpoints[0].abortAcknowledged,undefined);
  assert.equal(checkpoints[1].abortAcknowledged,true);assert.equal(checkpoints[2].sessionSettled,true);
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('完全访问确认所属根会话不匹配时不发停止请求',async()=>{
 const owned={url:'about:blank#/workspace/a/session/ses_Mine',sessionId:'ses_Mine',directory:'D:/isolated',rootKey:'A'};
 const job={rootSessions:[{key:'A',id:'ses_Other',url:owned.url,directory:owned.directory}]};
 await assert.rejects(()=>settleStoppedConsent({},job,owned,{},async()=>{}),/不属于本轮停止的Session/);
});

test('完全访问确认关闭后根会话自然完成时允许交接',async()=>{
 const owned={url:'about:blank#/workspace/a/session/ses_Mine',sessionId:'ses_Mine',directory:'D:/isolated',rootKey:'A'};
 const root={key:'A',id:owned.sessionId,url:owned.url,directory:owned.directory,modelCompleted:true,sessionSettled:false};
 let checkpoints=0;
 assert.equal(await settleStoppedConsent({}, {rootSessions:[root]},owned,{},async()=>{checkpoints++;}),true);
 assert.equal(root.abortAcknowledged,undefined);assert.equal(checkpoints,1);
});

test('已确认停止的根会话只读核对空闲，不再调用审批或停止接口',async()=>{
 let aborts=0,permissions=0;
 const server=http.createServer((request,response)=>{
  const route=new URL(request.url,'http://localhost').pathname;response.setHeader('content-type','application/json');
  if(route==='/session/ses_Mine')return response.end(JSON.stringify({id:'ses_Mine',directory:'D:/isolated'}));
  if(route==='/session/status')return response.end('{}');
  if(route==='/permission')permissions++;
  if(route.endsWith('/abort'))aborts++;
  response.statusCode=400;response.end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const owned={url:'about:blank#/workspace/a/session/ses_Mine',sessionId:'ses_Mine',directory:'D:/isolated',rootKey:'A'};
  const root={key:'A',id:owned.sessionId,url:owned.url,directory:owned.directory,abortAcknowledged:true};
  const connection={baseUrl:'http://127.0.0.1:'+server.address().port,opencodeUsername:'fixture',opencodePassword:'synthetic'};
  assert.equal(await settleStoppedConsent({}, {rootSessions:[root]},owned,connection,async()=>{},{allowAbort:false}),true);
  assert.equal(root.sessionSettled,true);assert.equal(aborts,0);assert.equal(permissions,0);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

async function consentFixture(page){
 await page.setContent('<section><button>拒绝</button><button>允许一次</button><button>开启完全访问权限</button></section>');
 await page.evaluate(()=>{
  window.consentClicks={open:0,confirm:0,cancel:0};
  const card=document.querySelector('section'),root={stateNode:{}};root.stateNode.current=root;
  card.__reactFiber$fixture={return:root,memoizedProps:{permission:{id:'per_A',sessionID:'ses_A'},respondPermission:()=>{}}};
  card.querySelectorAll('button')[2].onclick=()=>{
   window.consentClicks.open++;
   setTimeout(()=>{
    const dialog=document.createElement('div');dialog.setAttribute('role','dialog');
    dialog.innerHTML='<h2>确认开启完全访问权限</h2><button>取消</button><button>同意并开启</button>';
    document.body.appendChild(dialog);
    dialog.querySelectorAll('button')[0].onclick=()=>{window.consentClicks.cancel++;dialog.remove();};
    dialog.querySelectorAll('button')[1].onclick=()=>{window.consentClicks.confirm++;dialog.remove();};
   },100);
  };
 });
}

test('完全访问先登记，正常确认或首击后停止都清除本轮归属',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.goto('about:blank#/workspace/a/session/ses_A');
  for(const stopping of [false,true]){
   await consentFixture(page);const phases=[];
   const consentCheckpoint=async phase=>{phases.push(phase);return {stopRequested:stopping&&phase==='confirming'};};
   const action=()=>handleConfiguredDialog(page,{approval:'full',stepInterval:0.1},async()=>{},()=>{},
    {kind:'permission',expectedPermission:{id:'per_A',sessionID:'ses_A'},consentCheckpoint});
   if(stopping)await assert.rejects(action,error=>error.blocked&&error.message.includes('已取消'));
   else assert.equal(await action(),true);
   assert.deepEqual(phases,['prepared','opening','confirming','closed']);
   assert.deepEqual(await page.evaluate(()=>window.consentClicks),{open:1,confirm:stopping?0:1,cancel:stopping?1:0});
   assert.equal(await page.getByRole('dialog').count(),0);
  }
 }finally{await browser.close();}
});

test('完全访问收尾只取消相同根Session的相同审批，未决状态保留',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.goto('about:blank#/workspace/a/session/ses_A');await consentFixture(page);
  const owned={url:page.url(),sessionId:'ses_A',id:'per_A',phase:'opening',rootKey:'A'};
  await page.getByRole('button',{name:'开启完全访问权限'}).click();await page.getByRole('dialog').waitFor();
  await page.locator('section').evaluate(element=>{element.style.display='none';});
  await assert.rejects(()=>cancelApprovalConsent(page,{...owned,id:'per_B'}),/审批请求不匹配/);
  await assert.rejects(()=>cancelApprovalConsent(page,{...owned,url:owned.url.replace('ses_A','ses_B'),sessionId:'ses_B',rootKey:'B'}),/页面不属于/);
  assert.equal(await page.getByRole('dialog').count(),1);
  assert.equal((await page.evaluate(()=>window.consentClicks)).cancel,0);
  await cancelApprovalConsent(page,owned);
  assert.equal((await page.evaluate(()=>window.consentClicks)).cancel,1);
  await assert.rejects(()=>cancelApprovalConsent(page,owned),/结果尚未确认/);
  await cancelApprovalConsent(page,{...owned,phase:'prepared'});
  await assert.rejects(()=>cancelApprovalConsent(page,{...owned,phase:'confirming'},{resolved:async()=>false}),/结果尚未确认/);
  await assert.rejects(()=>cancelApprovalConsent(page,{...owned,phase:'confirming'},{resolved:async()=>{throw Error('接口不可用');}}),/接口不可用/);
  await cancelApprovalConsent(page,{...owned,phase:'confirming'},{resolved:async()=>true});
 }finally{await browser.close();}
});

test('点击命令超时后300ms原请求才消失，不重复点击也不提前失败',async()=>{
 let clicks=0,pending=true;const events=[],timers=[];
 const page={url:()=>'/session/ses_Mine',waitForTimeout:delay};
 try{
  const result=await clickApproval({page,originUrl:page.url(),checkReload:async()=>{},log:(...args)=>events.push(args),
   button:{click:async()=>{clicks++;timers.push(setTimeout(()=>{pending=false;},300));throw Object.assign(Error('click command timed out'),{name:'TimeoutError'});}},
   canAct:async()=>pending,timeoutMs:100,recoveryMs:1000});
  assert.equal(clicks,1);assert.equal(pending,false);assert.equal(result,'resolved');
  assert.ok(events.some(([name])=>name==='原审批请求已消失'));
 }finally{timers.forEach(clearTimeout);}
});

test('完全访问点击超时后原请求已消失，不等待不存在的确认框',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<section><button>拒绝</button><button>允许一次</button><button>开启完全访问权限</button></section><div style="position:fixed;inset:0;z-index:10"></div>');
  let checks=0;
  const handled=await handleConfiguredDialog(page,{approval:'full',stepInterval:0.1},async()=>{},()=>{},
   {kind:'permission',canAct:async()=>++checks<=2,clickTimeoutMs:100,clickRecoveryMs:1000});
  assert.equal(handled,false);
  assert.equal(await page.getByRole('heading',{name:'确认开启完全访问权限'}).count(),0);
 }finally{await browser.close();}
});

test('完全访问点击完成后原请求消失且未显示确认框，交回引擎判断',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<section><button>拒绝</button><button>允许一次</button><button onclick="this.closest(\'section\').remove()">开启完全访问权限</button></section>');
  const handled=await handleConfiguredDialog(page,{approval:'full',stepInterval:0.1},async()=>{},()=>{},
   {kind:'permission',canAct:async()=>await page.locator('section').count()===1});
  assert.equal(handled,false);
 }finally{await browser.close();}
});

test('补丁列表持续400时用连续事件处理两次授权并确认会话完成',async()=>{
 let stage=0,stream;const clicks=[],events=[];
 const req=n=>({id:'per_'+n,sessionID:'ses_Mine',permission:n===0?'external_directory':'edit'});
 const emit=(type,properties)=>stream.write('data: '+JSON.stringify({type,properties})+'\r\n\r\n');
 const server=http.createServer((request,response)=>{
  const route=new URL(request.url,'http://localhost');response.setHeader('content-type','application/json');
  if(route.pathname==='/event'){
   response.setHeader('content-type','text/event-stream');stream=response;
   // Split the frame terminator to exercise real streaming chunk boundaries.
   response.write('data: {"type":"server.connected","properties":{}}\r\n');response.write('\r\n');return;
  }
  if(route.pathname==='/permission'){
   if(stage>=1){response.statusCode=400;response.end(JSON.stringify({data:{message:'Expected JSON value: filePath patch movePath:undefined'}}));return;}
   response.end(JSON.stringify(stage===0?[req(0)]:[]));return;
  }
  if(route.pathname==='/question'){response.end('[]');return;}
  if(route.pathname==='/session/status'){response.end(JSON.stringify(stage<2?{ses_Mine:{type:'busy'}}:{}));return;}
  response.statusCode=404;response.end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser,control;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  await page.goto('about:blank#/session/ses_Mine');
  const render=()=>page.evaluate(p=>{
   document.body.innerHTML='<section><p>需要授权</p><button>拒绝</button><button>允许一次</button><button>在会话期间允许</button><button>开启完全访问权限</button></section>';
   const card=document.querySelector('section'),root={stateNode:{}};root.stateNode.current=root;
   card.__reactFiber$fixture={memoizedProps:{permission:p,respondPermission:()=>{}},return:root};
   card.querySelectorAll('button')[2].onclick=()=>window.replyPermission(p.id);
  },req(stage));
  await page.exposeFunction('replyPermission',async id=>{
   assert.equal(id,req(stage).id);clicks.push(id);emit('permission.replied',{sessionID:'ses_Mine',requestID:id});stage++;
   if(stage===1){
    emit('permission.asked',{id:'per_Foreign',sessionID:'ses_Other',permission:'edit'});
    emit('permission.asked',req(1));await render();
   }else await page.evaluate(()=>document.body.replaceChildren());
  });
  await render();
  control=new TaskControl({url:'unused',token:'isolated'});
  control.sessionId='ses_Mine';control.sessionUrl=page.url();control.directory='D:/isolated';
  control.connection={baseUrl:'http://127.0.0.1:'+server.address().port,opencodeUsername:'test',opencodePassword:'isolated'};
  control.withUI=async(_page,_phase,action)=>action();let completed=false;
  control.call=async action=>{if(action==='completed')completed=true;};
  control.readLog=async()=>({messages:[{info:{role:'assistant',finish:'stop',time:{completed:1}},parts:[{type:'text',text:'实际最终回复'}]}]});
  await control.wait(page,{approval:'session',stepInterval:0.1},{timeoutMs:12000,capture:async()=>{},log:(...args)=>events.push(args)});
  assert.deepEqual(clicks,['per_0','per_1']);assert.equal(completed,true);assert.equal(stage,2);
  assert.ok(events.some(([name])=>name.includes('使用本会话实时审批事件')));
  assert.ok(!JSON.stringify(events).includes('per_Foreign'));
 }finally{await control?.close();await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('未建基线或断流不使用审批缓存，快照竞态不复活已回答请求',async()=>{
 const ledger=new PermissionEvents({connection:{},sessionId:'ses_Mine',directory:'D:/isolated'});
 ledger.accept({type:'server.connected'});
 ledger.accept({type:'permission.asked',properties:{id:'per_Old',sessionID:'ses_Mine'}});
 assert.equal(ledger.snapshot(),null,'未建立HTTP基线不能降级');
 const since=ledger.checkpoint();
 ledger.accept({type:'permission.replied',properties:{requestID:'per_Old',sessionID:'ses_Mine'}});
 ledger.seed([{id:'per_Old',sessionID:'ses_Mine'}],since);
 assert.deepEqual(ledger.snapshot(),[],'旧HTTP响应不能复活已回答的审批');
 ledger.stop();assert.equal(ledger.snapshot(),null,'断线立即撤销缓存可信度');
});

test('相同文案的新审批替换旧请求后不误点',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<section><button>拒绝</button><button>允许一次</button><button onclick="window.clicked=true">在会话期间允许</button><button>开启完全访问权限</button></section>');
  await page.evaluate(()=>{
   const root={stateNode:{}};root.stateNode.current=root;
   document.querySelector('section').__reactFiber$fixture={return:root,memoizedProps:{permission:{id:'per_New',sessionID:'ses_Mine'},respondPermission:()=>{}}};
  });
  const handled=await handleConfiguredDialog(page,{approval:'session',stepInterval:0.1},async()=>{},()=>{},{kind:'permission',expectedPermission:{id:'per_Old',sessionID:'ses_Mine'},canAct:async()=>true});
  assert.equal(handled,false);assert.equal(await page.evaluate(()=>Boolean(window.clicked)),false);
 }finally{await browser.close();}
});

test('点击超时且原请求持续存在时明确BLOCKED，不重复点击',async()=>{
 const page={url:()=>'/session/ses_Mine',waitForTimeout:delay};let clicks=0;
 await assert.rejects(()=>clickApproval({page,originUrl:page.url(),checkReload:async()=>{},log:()=>{},timeoutMs:100,recoveryMs:200,canAct:async()=>true,
  button:{click:async()=>{clicks++;throw Object.assign(Error('timeout'),{name:'TimeoutError'});}}}),error=>error.blocked&&error.approvalClickUncertain);
 assert.equal(clicks,1);
});
