import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {selectModel} from './mobilework-run-policy.mjs';

async function withMenu(mode,run){
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<button aria-label="模型" aria-expanded="false"><svg><path d="M3.624"/></svg>auto</button><div id="menu"></div>');
  await page.evaluate(mode=>{
   window.clicks=[];window.opened=0;window.changedAt=0;window.selected='auto';
   window.rows=[['auto','auto'],['target','gpt-6-luna'],['other','gpt-6.1-sol']];
   const trigger=document.querySelector('button'),menu=document.querySelector('#menu');
   window.render=()=>{
    menu.replaceChildren();const box=document.createElement('div');box.setAttribute('role','listbox');menu.append(box);
    for(const [id,name] of window.rows){
     const row=document.createElement('div');row.setAttribute('role','option');row.setAttribute('data-value',id);row.setAttribute('data-checked',String(window.selected===id));
     const span=document.createElement('span');span.className='truncate';span.textContent=name;row.append(span);box.append(row);
     row.onclick=()=>{window.clicks.push({id,at:Date.now()});if(mode!=='ignored')window.selected=id;menu.replaceChildren();trigger.setAttribute('aria-expanded','false');};
    }
   };
   trigger.onclick=()=>{
    trigger.setAttribute('aria-expanded','true');window.opened++;
    if(window.opened===1){
     if(mode==='delayed')window.rows=[['auto','auto']];
     if(mode==='duplicate')window.rows.push(['second-target','gpt-6-luna']);
    }
    window.render();
    if(window.opened===1&&(mode==='reorder'||mode==='delayed'))setTimeout(()=>{
     window.rows=mode==='reorder'?[['late','late-loaded-model'],...window.rows]:[['auto','auto'],['target','gpt-6-luna']];
     window.changedAt=Date.now();window.render();
    },mode==='delayed'?1600:350);
   };
   document.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.replaceChildren();trigger.setAttribute('aria-expanded','false');}});
  },mode);
  await run(page);
 }finally{await browser.close();}
}

test('模型列表异步插入并替换DOM后，等待稳定且只点击唯一目标',async()=>withMenu('reorder',async page=>{
 assert.equal(await selectModel(page,'gpt-6-luna',{stepInterval:0.1}),'gpt-6-luna');
 const result=await page.evaluate(()=>({clicks,changedAt,rows}));
 assert.equal(result.rows.filter(r=>r[1]==='gpt-6-luna').length,1);
 assert.deepEqual(result.clicks.map(c=>c.id),['target']);
 assert.ok(result.clicks[0].at-result.changedAt>=1000,'刷新后稳定一秒才点击');
}));

test('初始列表已显示但目标延迟加载，不提前报不存在',async()=>withMenu('delayed',async page=>{
 assert.equal(await selectModel(page,'gpt-6-luna',{stepInterval:0.1}),'gpt-6-luna');
 assert.deepEqual(await page.evaluate(()=>clicks.map(c=>c.id)),['target']);
}));

test('同一稳定列表确有两个同名模型时阻塞，不任意选择',async()=>withMenu('duplicate',async page=>{
 await assert.rejects(()=>selectModel(page,'gpt-6-luna',{stepInterval:0.1}),/模型重名.*同一列表/);
 assert.deepEqual(await page.evaluate(()=>clicks),[]);
}));

test('点击关闭菜单但选择没有生效时，回读拒绝假成功',async()=>withMenu('ignored',async page=>{
 await assert.rejects(()=>selectModel(page,'gpt-6-luna',{stepInterval:0.1}),/模型切换未生效/);
 assert.deepEqual(await page.evaluate(()=>clicks.map(c=>c.id)),['target']);
}));
