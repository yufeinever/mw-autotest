import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {handleConfiguredDialog} from './mobilework-run-policy.mjs';

// Text and control structure verified against the installed MobileWork renderer.
const fixture=`<main id="permissions"></main><script>
 window.confirmations=[];
 window.consent=()=>{
  const modal=document.createElement('div');modal.setAttribute('role','dialog');
  modal.innerHTML='<h2>确认开启完全访问权限</h2><p>开启后AI可直接执行文件修改、命令执行等敏感操作，无需逐项确认。建议仅在信任当前任务时使用。</p><button>取消</button><button id="confirm">同意并开启</button>';
  window.shown=Date.now();document.body.append(modal);
  modal.querySelector('#confirm').onclick=()=>{window.confirmations.push(Date.now()-window.shown);modal.remove();document.querySelector('#permissions').innerHTML='';if(window.reload){document.body.insertAdjacentHTML('beforeend','<div role="dialog">配置已更新，需要重新加载引擎<button onclick="window.terminated=true">立即终止并生效</button></div>');}};
 };
 window.render=()=>{document.querySelector('#permissions').innerHTML='<section><p>执行工具需要审批</p><button>拒绝</button><button>允许一次</button><button>在会话期间允许</button><button onclick="setTimeout(window.consent,150)">开启完全访问权限</button></section>';};window.render();
</script>`;
async function setup(t){
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setContent(fixture);return page;
}
const handle=(page,capture=async()=>{},canAct=async()=>true)=>handleConfiguredDialog(page,{approval:'full'},capture,()=>{},{kind:'permission',canAct});

test('完全访问：连续审批均等待延迟二次确认及1秒后再同意',async t=>{
 const page=await setup(t),steps=[];
 for(let i=0;i<2;i++){
  assert.equal(await handle(page,async step=>steps.push(step)),true);
  if(i===0)await page.evaluate(()=>window.render());
 }
 const waits=await page.evaluate(()=>window.confirmations);
 assert.equal(waits.length,2);assert.ok(waits.every(n=>n>=1000));
 assert.equal(steps.filter(s=>s==='完全访问权限-二次确认前').length,2);
 assert.equal(steps.filter(s=>s==='完全访问权限-二次确认后').length,2);
});
test('完全访问：截图期间原审批失效时不确认',async t=>{
 const page=await setup(t);let current=true;
 await assert.rejects(()=>handle(page,async step=>{if(step==='完全访问权限-二次确认前')current=false;},async()=>current),e=>e.blocked&&/审批请求已变化/.test(e.message));
 assert.deepEqual(await page.evaluate(()=>window.confirmations),[]);
});
test('完全访问：同文案弹框被替换后不误点',async t=>{
 const page=await setup(t);
 await assert.rejects(()=>handle(page,async step=>{if(step==='完全访问权限-二次确认前')await page.evaluate(()=>{document.querySelector('[role="dialog"]').remove();window.consent();});}),e=>e.blocked&&/二次确认已变化/.test(e.message));
 assert.deepEqual(await page.evaluate(()=>window.confirmations),[]);
});
test('完全访问：确认后配置重载明确阻塞且不点击终止',async t=>{
 const page=await setup(t);await page.evaluate(()=>window.reload=true);
 await assert.rejects(()=>handle(page),e=>e.blocked&&/重新加载引擎/.test(e.message));
 assert.equal(await page.evaluate(()=>window.confirmations.length),1);
 assert.equal(await page.evaluate(()=>window.terminated),undefined);
});
