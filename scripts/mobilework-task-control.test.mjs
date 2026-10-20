import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium} from 'playwright-core';
import {TaskControl} from './mobilework-task-control.mjs';
import {TaskScheduler} from '../local-console/task-scheduler.mjs';
import {normalizeConfig} from '../local-console/policy.mjs';
import {readSessionLog} from '../local-console/session-log.mjs';

test('两个模型任务重叠等待；真实DOM按会话轮流回答和审批；外部切换不误操作',async()=>{
 const jobs=['A','B'].map(id=>({id,status:'QUEUED',config:normalizeConfig({executionStrategy:'parallel',maxParallel:2})}));
 const scheduler=new TaskScheduler(),sessions=new Map(),actions=[],turns=[];
 const user=id=>'本次独立测试任务 '+id+'，保留这条完整消息用于回读核验。';
 const session=id=>({id:'ses_'+id,directory:'D:/isolated/task-'+id});
 for(const id of ['A','B'])sessions.set(id,{pending:null,done:false});
 let address;
 const server=http.createServer(async(req,res)=>{
  const route=new URL(req.url,address),send=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
  if(route.pathname==='/MobileWork/resources/app-dist/index.html'){
   res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><button onclick="location.hash='/workspace/demo/session'">新建任务</button><main></main><script>
   let fingerprint='';const root=document.querySelector('main');
   async function render(){const id=location.hash.match(/ses_([AB])$/)?.[1];if(!id){root.innerHTML='<div contenteditable="true"></div>';fingerprint='';return;}
    const data=await(await fetch('/view/'+id)).json();if(!location.hash.endsWith('ses_'+id))return;const next=JSON.stringify(data);if(fingerprint===next)return;fingerprint=next;
    root.replaceChildren();const message=document.createElement('p');message.textContent=data.user;root.append(message);
    if(data.pending==='question'){const card=document.createElement('div'),q=document.createElement('p');card.className='border-[var(--mw-question-panel-border)]';q.textContent=id+' 选择方案';card.append(q);
     const close=document.createElement('button');close.setAttribute('aria-label','关闭');close.textContent='×';card.append(close);
     for(let n=1;n<=2;n++){const b=document.createElement('button');b.textContent=n+'方案'+n;b.onclick=()=>reply(id,'选项'+n);card.append(b);}root.append(card);
    }else if(data.pending==='permission'){const card=document.createElement('section');for(const label of ['拒绝','允许一次','在会话期间允许','开启完全访问权限']){const b=document.createElement('button');b.textContent=label;b.onclick=()=>reply(id,label);card.append(b);}root.append(card);}
    if(data.done){const p=document.createElement('p');p.textContent='最终助手回复 '+id;root.append(p);}
   }
   async function reply(id,action){await fetch('/answer/'+id,{method:'POST',body:JSON.stringify({action})});await render();}
   window.__OPENWORK_ELECTRON__={invokeDesktop:async()=>({baseUrl:location.origin,opencodeUsername:'test',opencodePassword:'isolated-engine-secret'})};
   addEventListener('hashchange',render);setInterval(render,100);render();</script>`);return;
  }
  const control=route.pathname.match(/^\/control\/([AB])\/(\w[\w-]*)$/);
  if(control){let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{},id=control[1],action=control[2];
   if(action==='acquire'){const r=scheduler.acquire(id,body.phase);if(r.granted)turns.push({id,phase:body.phase});return send(r);}
   if(action==='release'){scheduler.release(id,body);return send({ok:true});}
   if(action==='completed'){jobs.find(j=>j.id===id).modelCompleted=true;return send({ok:true});}
   if(action==='is-managed')return send({managed:jobs.some(j=>j.sessionUrl===body.url)});
  }
  const view=route.pathname.match(/^\/view\/([AB])$/);if(view)return send({...sessions.get(view[1]),user:user(view[1])});
  const answer=route.pathname.match(/^\/answer\/([AB])$/);if(answer){let raw='';for await(const chunk of req)raw+=chunk;actions.push({id:answer[1],...JSON.parse(raw)});sessions.set(answer[1],{pending:null,done:true});return send(true);}
  if(route.pathname==='/session/status')return send(Object.fromEntries([...sessions].filter(([,s])=>!s.done).map(([id])=>['ses_'+id,{type:'busy'}])));
  if(route.pathname==='/question')return send([...sessions].filter(([,s])=>s.pending==='question').map(([id])=>({id:'que_'+id,sessionID:'ses_'+id,questions:[{question:id+' 选择方案'}]})));
  if(route.pathname==='/permission')return send([...sessions].filter(([,s])=>s.pending==='permission').map(([id])=>({id:'per_'+id,sessionID:'ses_'+id})));
  const log=route.pathname.match(/^\/session\/ses_([AB])(\/message|\/children)?$/);
  if(log){const id=log[1];if(log[2]==='/children')return send([]);if(!log[2])return send(session(id));
   const messages=[{info:{id:'msg_'+id,sessionID:'ses_'+id,role:'user'},parts:[{type:'text',text:'Load [skill mock-skill] and follow its instructions.\n'+user(id)}]}];
   if(sessions.get(id).done)messages.push({info:{sessionID:'ses_'+id,role:'assistant',time:{completed:Date.now()},finish:'stop'},parts:[{type:'text',text:'最终助手回复 '+id}]});
   return send(messages);
  }
  res.statusCode=404;send({error:'fixture route not found'});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));address='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.goto(address+'/MobileWork/resources/app-dist/index.html#/workspace/demo/session');
  const controls=jobs.map(j=>new TaskControl({url:address+'/control/'+j.id,token:'isolated'}));
  for(const j of jobs)scheduler.enqueue(j,{cooperative:true,start:()=>{}});
  assert.equal(jobs[1].status,'QUEUED');
  await controls[0].begin(page);await page.evaluate(()=>location.hash='/workspace/demo/session/ses_A');await page.waitForURL(/ses_A$/);await controls[0].submitted(page,'ses_A');
  assert.equal(jobs[1].status,'RUNNING');assert.equal(sessions.get('A').done,false);
  await controls[1].begin(page);await page.evaluate(()=>location.hash='/workspace/demo/session/ses_B');await page.waitForURL(/ses_B$/);await controls[1].submitted(page,'ses_B');
  assert.equal(sessions.get('A').done,false,'B已经提交时A仍在模型处理阶段');assert.equal(sessions.get('B').done,false);
  sessions.get('A').pending='question';sessions.get('B').pending='permission';
  const logs=await Promise.all(controls.map((control,index)=>control.wait(page,normalizeConfig({question:'first',approval:'session'}),{timeoutMs:20000,capture:async()=>assert.ok(page.url().endsWith('/ses_'+jobs[index].id)),log:()=>{}})));
  assert.deepEqual(actions,[{id:'A',action:'选项1'},{id:'B',action:'在会话期间允许'}]);
  assert.deepEqual(logs.map(d=>d.sessionId),['ses_A','ses_B']);assert.ok(jobs.every(j=>j.modelCompleted));
  assert.deepEqual(turns.filter(t=>t.phase==='INTERACTING').map(t=>t.id),['A','B']);
  assert.ok(!JSON.stringify(logs).includes('isolated-engine-secret'));
  await page.evaluate(()=>location.hash='/workspace/demo/session/ses_foreign');await page.waitForURL(/ses_foreign$/);
  let clicked=false;await assert.rejects(()=>controls[0].withUI(page,'EVIDENCE',async()=>{clicked=true;}),/调度之外/);assert.equal(clicked,false);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});

test('空引擎地址明确阻塞，不把null转为空地址继续请求',async()=>{
 await assert.rejects(()=>readSessionLog({sessionId:'ses_A',connection:{baseUrl:null}}),/引擎尚未就绪/);
});
