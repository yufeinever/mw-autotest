import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {questionPanel,questionOptions,handleConfiguredDialog} from './mobilework-run-policy.mjs';

test('真实提问卡片交互回归',async t=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(3000);
  const config={question:'first',approval:'session',customText:''};
  const handle=overrides=>handleConfiguredDialog(page,{...config,...overrides},async()=>{},()=>{});
  await t.test('ARIA 隐藏、无跳过按钮、连续两题自动提交，不误点下一题的发送',async()=>{
   await page.setContent(`<main><div aria-hidden="true" id="question"></div></main><script>
    window.answers=[];window.sendClicks=0;window.shown=[];
    window.render=()=>{
     if(window.answers.length===2){document.querySelector('#question').innerHTML='全部回答完成';return;}
     window.shown.push(Date.now());
     document.querySelector('#question').innerHTML='<section><h2>第'+(window.answers.length+1)+'题</h2><div><button onclick="answer(1)"><span>1</span><span>第一选项</span></button><button onclick="answer(2)"><span>2</span><span>第二选项</span></button></div><footer><button disabled tabindex="-1" onclick="window.sendClicks++">发送</button></footer></section>';
    };
    window.answer=n=>{window.answers.push({choice:n,wait:Date.now()-window.shown.at(-1)});window.render();};window.render();
   </script>`);
   const panel=await questionPanel(page);assert.ok(panel);assert.equal(await questionOptions(panel).count(),2);
   for(let i=0;i<2;i++)assert.equal(await handle(),true);
   const result=await page.evaluate(()=>({answers:window.answers,sendClicks:window.sendClicks}));
   assert.deepEqual(result.answers.map(x=>x.choice),[1,1]);assert.ok(result.answers.every(x=>x.wait>=1000));assert.equal(result.sendClicks,0);
   assert.equal(await handle(),false);
  });
  await t.test('第二项点击后自动关闭卡片，不等待已经移除的发送按钮',async()=>{
   await page.setContent(`<section><h2>选择范围</h2><button onclick="window.choice=1;this.closest('section').remove()"><span>1</span><span>第一项</span></button><button onclick="window.choice=2;this.closest('section').remove()"><span>2</span><span>第二项</span></button><button disabled>发送</button></section>`);
   assert.equal(await handle({question:'second'}),true);assert.equal(await page.evaluate(()=>window.choice),2);
   assert.equal(await questionPanel(page),null);
  });
  await t.test('旧版选择后保留卡片时，提交本题的发送按钮',async()=>{
   await page.setContent(`<section><button onclick="window.choice=1;document.querySelector('#send').disabled=false"><span>1</span><span>第一项</span></button><button onclick="window.choice=2;document.querySelector('#send').disabled=false"><span>2</span><span>第二项</span></button><button>跳过</button><button disabled id="send" onclick="window.sent=window.choice">发送</button></section>`);
   assert.equal(await handle({question:'second'}),true);assert.equal(await page.evaluate(()=>window.sent),2);
  });
  await t.test('自定义答案填写真实输入框后发送',async()=>{
   await page.setContent(`<section><textarea oninput="document.querySelector('#send').disabled=false"></textarea><footer><button disabled id="send" onclick="window.customAnswer=document.querySelector('textarea').value">发送</button></footer></section>`);
   assert.equal(await handle({question:'custom',customText:'通用安排，工作时间 09:00—18:00'}),true);
   assert.equal(await page.evaluate(()=>window.customAnswer),'通用安排，工作时间 09:00—18:00');
  });
  await t.test('第二项不存在时明确阻塞，不发送第一项',async()=>{
   await page.setContent('<section><button><span>1</span><span>唯一选项</span></button><button disabled>发送</button></section>');
   await assert.rejects(()=>handle({question:'second'}),/没有2个选项/);
  });
 }finally{await browser.close();}
});
