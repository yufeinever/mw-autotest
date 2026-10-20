import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {questionPanel,handleConfiguredDialog} from './mobilework-run-policy.mjs';

// Match the installed renderer's shell and native numbered buttons. Its
// single-choice flow has no footer at all, not even a disabled Send button.
const shell=content=>`<div class="border-[var(--mw-question-panel-border)]"><header>本周任务<button aria-label="关闭">×</button></header>${content}</div>`;
const config={question:'first',approval:'session',customText:'通用安排'};
async function withPage(action){
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();page.setDefaultTimeout(2000);await action(page);}finally{await browser.close();}
}
test('无发送卡片连续选第一项，每题等待1秒，不误提交下一题',()=>withPage(async page=>{
 await page.setContent(`<main><button onclick="window.stray=true">1 正文中的无关按钮</button><div aria-hidden="true" id="questions"></div></main><script>
 window.answers=[];window.sendClicks=0;window.render=()=>{
  window.shown=Date.now();
  document.querySelector('#questions').innerHTML=${JSON.stringify(shell('<p id="title"></p><button onclick="answer(1)"><span>1</span><span>采用通用安排</span></button><button onclick="answer(2)"><span>2</span><span>仅规划剩余三天</span></button>'))};
  document.querySelector('#title').textContent='第'+(window.answers.length+1)+'题';
  if(window.answers.length===2)document.querySelector('#questions>div').insertAdjacentHTML('beforeend','<button onclick="window.sendClicks++">发送</button>');
 };
 window.answer=n=>{window.answers.push({choice:n,wait:Date.now()-window.shown});window.render();};window.render();
 </script>`);
 const events=[];
 for(let i=0;i<2;i++)assert.equal(await handleConfiguredDialog(page,config,async()=>{},(...args)=>events.push(args)),true);
 const result=await page.evaluate(()=>({answers:window.answers,sendClicks:window.sendClicks,stray:!!window.stray}));
 assert.deepEqual(result.answers.map(a=>a.choice),[1,1]);assert.ok(result.answers.every(a=>a.wait>=1000));
 assert.equal(result.sendClicks,0);assert.equal(result.stray,false);assert.equal(events.length,2);
}));
test('无发送卡片第二项自动提交并关闭；无关编号及多个面板不误点',()=>withPage(async page=>{
 const content='<button onclick="window.choice=1;this.parentElement.remove()"><span>1</span>第一项</button><button onclick="window.choice=2;this.parentElement.remove()"><span>2</span>第二项</button>';
 await page.setContent(shell(content));
 assert.equal(await handleConfiguredDialog(page,{...config,question:'second'},async()=>{},()=>{}),true);
 assert.equal(await page.evaluate(()=>window.choice),2);assert.equal(await questionPanel(page),null);
 await page.setContent('<button>1 无关编号</button><button>2 无关编号</button>');assert.equal(await questionPanel(page),null);
 await page.setContent(shell(content)+shell(content));await assert.rejects(()=>questionPanel(page),/多个提问面板/);
}));
test('旧式发送与新式输入后才出现发送均可提交',()=>withPage(async page=>{
 await page.setContent('<section><button onclick="window.choice=1;document.querySelector(\'#send\').disabled=false"><span>1</span>第一项</button><button id="send" disabled onclick="window.sent=window.choice">发送</button></section>');
 assert.equal(await handleConfiguredDialog(page,config,async()=>{},()=>{}),true);assert.equal(await page.evaluate(()=>window.sent),1);
 await page.setContent(shell('<input placeholder="请输入其他补充...">'));
 // Use a real DOM event listener to model the conditional footer.
 await page.locator('input').evaluate(input=>{input.oninput=()=>{if(document.querySelector('#send'))return;const send=document.createElement('button');send.id='send';send.textContent='发送';send.onclick=()=>{window.custom=input.value;};input.after(send);};});
 assert.equal(await handleConfiguredDialog(page,{...config,question:'custom'},async()=>{},()=>{}),true);
 assert.equal(await page.evaluate(()=>window.custom),'通用安排');
}));
