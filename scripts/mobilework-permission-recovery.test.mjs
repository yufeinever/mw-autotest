import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {clickApproval,handleConfiguredDialog} from './mobilework-run-policy.mjs';
import {PermissionEvents} from './mobilework-permission-events.mjs';
import {TaskControl} from './mobilework-task-control.mjs';

test('点击命令超时后300ms原请求才消失，不重复点击也不提前失败',async()=>{
 let clicks=0,pending=true;const events=[],timers=[];
 const page={url:()=>'/session/ses_Mine',waitForTimeout:delay};
 try{
  await clickApproval({page,originUrl:page.url(),checkReload:async()=>{},log:(...args)=>events.push(args),
   button:{click:async()=>{clicks++;timers.push(setTimeout(()=>{pending=false;},300));throw Object.assign(Error('click command timed out'),{name:'TimeoutError'});}},
   canAct:async()=>pending,timeoutMs:100,recoveryMs:1000});
  assert.equal(clicks,1);assert.equal(pending,false);
  assert.ok(events.some(([name])=>name==='原审批请求已消失'));
 }finally{timers.forEach(clearTimeout);}
});

test('补丁列表400用连续事件及真实渲染请求ID处理两次授权，最终等API恢复',async()=>{
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
   if(stage===1){response.statusCode=400;response.end(JSON.stringify({data:{message:'Expected JSON value: filePath patch movePath:undefined'}}));return;}
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
