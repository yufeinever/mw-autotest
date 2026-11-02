import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {PermissionTurn} from './mobilework-permission-turn.mjs';
import {TaskControl} from './mobilework-task-control.mjs';
import {RootSessionGroup} from './mobilework-root-session-group.mjs';

test('审批点击后独立计算确认等待',()=>{
 const turn=new PermissionTurn(15000),p={id:'a',sessionID:'ses_1',key:'permission:a'};
 assert.equal(turn.update([p],p,0).selected,p);
 turn.confirmedClick(p.key,60000);
 assert.equal(turn.update([p],p,74999).selected,p);
 assert.equal(turn.update([p],p,75000).reason,'active-timeout');
});

test('多根交互计时不累计其他根占用时间',async()=>{
 const realNow=Date.now;let time=1000;Date.now=()=>time;
 try{
  const group=new RootSessionGroup({control:{},page:{},config:{},dir:'unused',capture:async()=>{}});
  const makeRoot=key=>({key,id:'ses_'+key,completed:false,done:false,observed:new Map(),permissionTurn:new PermissionTurn(15000),questionsPaused:false,interactionTime:0,interactionStartedAt:null});
  const a=makeRoot('a'),b=makeRoot('b');let aTurns=0;
  const request=root=>({kind:'question',id:'q_'+root.key,key:'question:q_'+root.key,questions:[{question:'问题'}]});
  for(const root of [a,b])root.control={
   handlePendingInteractions:async(_page,_config,{now,observed})=>{
    if(root===b){time+=20000;b.done=true;return;}
    aTurns++;assert.equal(now()-observed.get('question:q_a').since,0);
    if(aTurns===2)a.done=true;
   },
   readLog:async()=>({messages:[{info:{role:'assistant',time:{completed:1},finish:'stop'},parts:[]}]}),
   call:async()=>{}
  };
  group.tasks=[a,b];group.observePending=async()=>{};group._suspendPending=async()=>true;
  group._sample=async root=>({root,state:root.done?'idle':'busy',pending:root.done?[]:[request(root)]});
  group.withRootUI=async(key,_phase,action)=>action(group.tasks.find(root=>root.key===key).control);
  await group.wait({timeoutMs:60000});
  assert.equal(aTurns,2);assert.equal(a.completed,true);assert.equal(b.completed,true);
 }finally{Date.now=realNow;}
});

test('并发审批独立计时，无可识别卡片也会超时',()=>{
 const clock=new PermissionTurn(15000);
 const a={id:'a',sessionID:'ses_1',key:'permission:a'},b={id:'b',sessionID:'ses_1',key:'permission:b'};
 assert.equal(clock.update([a,b],a,0).selected,a);
 assert.equal(clock.update([a,b],b,14999).selected,null);
 assert.equal(clock.update([b],b,15000).selected,b);
 assert.equal(clock.update([b],null,29999).reason,undefined);
 assert.equal(clock.update([b],null,30000).blocked,'permission:b');
 clock.update([],null,30001);
 assert.equal(clock.update([a],null,40000).reason,undefined);
 assert.equal(clock.update([a],null,55000).reason,'unidentified-timeout');
});

test('两个同时待审批请求按真实卡片ID逐条处理',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.goto('about:blank#/session/ses_1');
  const control=new TaskControl({url:'unused',token:'isolated'}),clicks=[],logs=[];
  control.sessionId='ses_1';control.sessionUrl=page.url();
  const pending=['per_a','per_b'];
  const request=id=>({id,sessionID:'ses_1'});
  control.get=async route=>route==='/session/status'?(pending.length?{ses_1:{type:'busy'}}:{}):route==='/question'?[]:pending.map(request);
  const render=()=>page.evaluate(p=>{
   if(!p){document.body.replaceChildren();return;}
   document.body.innerHTML='<section><button>拒绝</button><button>允许一次</button><button>在会话期间允许</button><button>开启完全访问权限</button></section>';
   const card=document.querySelector('section'),root={stateNode:{}};root.stateNode.current=root;
   card.__reactFiber$fixture={memoizedProps:{permission:p,respondPermission:()=>{}},return:root};
   card.querySelectorAll('button')[2].onclick=()=>window.resolvePermission(p.id);
  },pending.length?request(pending[0]):null);
  await page.exposeFunction('resolvePermission',async id=>{
   assert.equal(id,pending[0]);clicks.push(id);pending.shift();await render();
  });
  await render();control.withUI=async(_page,_phase,action)=>action();
  control.call=async()=>{};
  control.readLog=async()=>({messages:[{info:{role:'assistant',finish:'stop',time:{completed:1}},parts:[{type:'text',text:'完成'}]}]});
  await control.wait(page,{approval:'session',stepInterval:0.1},{timeoutMs:15000,interactionTimeoutMs:6000,capture:async()=>{},log:(...args)=>logs.push(args)});
  assert.deepEqual(clicks,['per_a','per_b']);
  assert.deepEqual(logs.filter(item=>item[0]==='交互已点击，等待引擎确认').map(item=>item[1]),['permission:per_a','permission:per_b']);
 }finally{await browser.close();}
});
