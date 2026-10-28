import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium} from 'playwright-core';
import {readEngineConnection,engineRequest,validateEngineConnection} from './engine-client.mjs';
import {readSessionLogFromPage} from './session-log.mjs';
import {stopSession} from './stop-job.mjs';
import {readModelOptions,modelTrigger} from '../scripts/mobilework-run-policy.mjs';

test('Node引擎链路不依赖页面fetch，保留鉴权、脱敏和停止归属保护',async()=>{
 let wrong=false,aborts=0;
 const server=http.createServer((req,res)=>{
  assert.equal(req.headers.authorization,'Basic '+Buffer.from('test:engine-secret').toString('base64'));
  res.setHeader('Content-Type','application/json');
  const route=new URL(req.url,'http://localhost').pathname;
  if(route.endsWith('/abort')){aborts++;return res.end('true');}
  if(route==='/session/status')return res.end(JSON.stringify({ses_test:{type:'idle'}}));
  if(route.endsWith('/message'))return res.end(JSON.stringify([{info:{sessionID:'ses_test',role:'assistant'},parts:[{type:'text',text:'engine-secret custom-secret'}]}]));
  res.end(JSON.stringify({id:wrong?'ses_other':'ses_test',directory:'C:/fixture'}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.evaluate(baseUrl=>{
   window.fetch=()=>{throw Error('renderer CORS blocked');};
   window.__OPENWORK_ELECTRON__={invokeDesktop:async()=>({baseUrl,opencodeUsername:'test',opencodePassword:'engine-secret'})};
   window.__MOBILEWORK__={invoke:async()=>({models:[{apiKey:'custom-secret'}]})};
  },'http://127.0.0.1:'+server.address().port);
  const connection=await readEngineConnection(page);
  assert.equal((await engineRequest(connection,'/session/status')).ses_test.type,'idle');
  const log=await readSessionLogFromPage(page,'ses_test');
  assert.equal(log.messageCount,1);assert.ok(!JSON.stringify(log).includes('custom-secret'));assert.ok(!JSON.stringify(log).includes('engine-secret'));
  const job={sessionId:'ses_test'};
  await stopSession(job,{connection});assert.equal(aborts,1);
  wrong=true;await assert.rejects(()=>stopSession(job,{connection}),/不一致/);assert.equal(aborts,1);
  await assert.rejects(()=>readSessionLogFromPage(page,'ses_test'),/不匹配/);
  assert.throws(()=>validateEngineConnection({baseUrl:'http://example.com'}),/非本机/);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});

test('停止已被客户端删除的会话时按已停止收尾，避免保留调度锁',async()=>{
 const server=http.createServer((req,res)=>{res.statusCode=404;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'not found'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const connection={baseUrl:'http://127.0.0.1:'+server.address().port,opencodeUsername:'test',opencodePassword:'secret'};
  assert.match(await stopSession({sessionId:'ses_deleted'},{connection}),/已不存在/);
 }finally{await new Promise(r=>server.close(r));}
});

test('新图标和上下文用量不干扰模型定位，图标按钮回读aria名称并拒绝歧义',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<section><button aria-label="运行任务"></button><button aria-expanded="false" aria-label="上下文用量"></button><button id="model" aria-expanded="false" aria-label="MOMA/DSV4"><svg><path d="M2 2"/></svg></button></section><div role="listbox" hidden><div role="option" data-checked="true"><span class="truncate">MOMA/DSV4</span></div></div><script>model.onclick=()=>document.querySelector('[role=listbox]').hidden=false;document.onkeydown=e=>{if(e.key==='Escape')document.querySelector('[role=listbox]').hidden=true;};</script>`);
  const result=await readModelOptions(page,{stepInterval:0.1});assert.equal(result.current,'MOMA/DSV4');assert.equal(result.models[0].name,'MOMA/DSV4');
  await page.evaluate(()=>document.querySelector('section').insertAdjacentHTML('beforeend','<button aria-expanded="false" aria-label="Other model"></button>'));
  await assert.rejects(()=>modelTrigger(page),/唯一/);
 }finally{await browser.close();}
});
