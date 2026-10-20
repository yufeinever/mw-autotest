import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {stringify} from 'yaml';
import {chromium} from 'playwright-core';
import {clientCases,getClientCase} from './client-case-catalog.mjs';
import {clientCaseInput} from './client-case-inputs.mjs';
import {textChecks,algorithmChecks,workflowChecks,diagramChecks,pptChecks,skillArchiveChecks,zipTextFiles,readArtifact} from './client-case-checks.mjs';
import {previewChecks} from './client-case-preview.mjs';
import {fillScenario,clearOwnedDraft,waitSentInput,waitCreatedSession,finalAssistantText,guardDialogs} from './client-case-runner.mjs';
import {withClientCases} from '../local-console/case-registry.mjs';
import {createConsole,projectRoot} from '../local-console/server.mjs';
import {normalizeConfig} from '../local-console/policy.mjs';

const all=checks=>checks.every(c=>c.pass),json=x=>'```json\n'+JSON.stringify(x)+'\n```';
test('前16条按原表映射，入口存在，补缺迁移保留旧ID和用户脚本',async()=>{
 assert.equal(clientCases.length,16);
 for(const c of clientCases){assert.equal(c.row,c.number+1);await fs.access(c.entry);if(c.number>=3)assert.ok(clientCaseInput(c.number,{outputDir:'D:/独立产物',asOfDate:'2026-10-18'}).length>100);}
 const old=[{id:'old-2',name:'我的会议',path:path.resolve(getClientCase(2).entry)},{id:'custom',name:'其他',path:path.resolve('other.mjs')}];
 const migrated=withClientCases(old,projectRoot);
 assert.equal(migrated.length,17);assert.deepEqual(migrated.slice(0,2),old);assert.deepEqual(withClientCases(migrated,projectRoot),migrated);assert.deepEqual(old.map(x=>x.id),['old-2','custom']);
});
test('邮件和公文内容拒绝缺失、错误日期和仅索要材料',()=>{
 const email='主题：星桥项目评审时间调整；项目组同事：2026年11月3日由14:00调整为15:30，三楼A会议室。请2026年11月2日18:00前反馈。许晴';
 assert.ok(all(textChecks(3,email)));assert.ok(!all(textChecks(3,email.replace('11月2日','11月4日'))));assert.ok(!all(textChecks(3,'请提供邮件资料')));
 const notice='关于开展办公设备盘点的通知\n各部门：电脑、显示器、打印机登记资产编号、使用人和设备状态，丢失损坏说明。2026年11月6日17:00前交赵宁803。星桥科技综合管理部2026年11月2日';
 assert.ok(all(textChecks(4,notice)));assert.ok(!all(textChecks(4,notice.replace('赵宁','赵明'))));
});
test('创意、研究和商品断言检查最终结构与具体筛选依据',()=>{
 const concepts={concepts:['上班族','儿童家庭','老年居民'].map((g,i)=>({name:'方案'+i,userGroup:g,scene:'邻里互助的具体使用场景与需求'+i,coreFeatures:['真实借用功能'+i,'真实交换功能'+i],differentiation:'针对特定人群的差异化说明'+i}))};
 assert.ok(all(textChecks(13,json(concepts))));concepts.concepts[1].coreFeatures=concepts.concepts[0].coreFeatures;assert.ok(!all(textChecks(13,json(concepts))));
 const products={products:[['Codex','https://developers.openai.com/codex/'],['Claude Code','https://code.claude.com/docs'],['WorkBuddy','https://www.workbuddy.cn/docs/workbuddy/Overview']].map(([name,url])=>({name,features:'代码与文档',usability:'使用门槛明确',pricing:'未核实价格',useCase:'假设使用场景',pros:'使用优势说明',cons:'存在边界限制',sources:[url]})),recommendation:'对于这个Windows团队，建议按权限审批、人工审查及成本验证结果选择适合的产品，并先小范围试点。'};
 assert.ok(all(textChecks(15,json(products))));products.products[0].sources=['https://openai.com.evil.example/fake'];assert.ok(!all(textChecks(15,json(products))));
 const shop={recommended:[{id:'A',reason:'预算重量容量全部满足'},{id:'B',reason:'满足所有硬性需求'}],excluded:[{id:'C',reason:'超预算8000'},{id:'D',reason:'重量超标'},{id:'E',reason:'内存与SSD容量不够'}],note:'虚构测试商品'};
 assert.ok(all(textChecks(16,json(shop))));shop.recommended[1].id='C';assert.ok(!all(textChecks(16,json(shop))));
});
test('独立代码行为检查覆盖异常、所有参数和错误实现',()=>{
 const priority='export function normalizePriority(v){if(typeof v!=="string")throw new TypeError();v=v.trim().toUpperCase();if(!["P0","P1","P2"].includes(v))throw new RangeError();return v;}';
 assert.ok(all(algorithmChecks(5,priority)));assert.ok(!all(algorithmChecks(5,priority.replace('v.trim().toUpperCase()','v'))));
 const clamp='export function clamp(v,min,max){if(![v,min,max].every(x=>typeof x==="number"&&Number.isFinite(x)))throw new TypeError();if(min>max)throw new RangeError();return Math.max(min,Math.min(max,v));}';
 assert.ok(all(algorithmChecks(9,clamp)));assert.ok(!all(algorithmChecks(9,clamp.replace('[v,min,max]','[v]'))));assert.ok(!all(algorithmChecks(9,'export function clamp(){while(true){}}')));
});
const workflow=()=>({name:'ci',on:{push:null,pull_request:null,workflow_dispatch:{inputs:{confirm:{type:'boolean',default:false}}}},permissions:{contents:'read'},jobs:{test:{'runs-on':'ubuntu-latest',steps:[{uses:'actions/checkout@v4'},{uses:'actions/setup-node@v4',with:{'node-version':22}},{run:'npm ci'},{run:'npm test'}]},build:{'runs-on':'ubuntu-latest',needs:'test',steps:[{uses:'actions/checkout@v4'},{uses:'actions/setup-node@v4',with:{'node-version':22}},{run:'npm ci'},{run:'npm run build'},{uses:'actions/upload-artifact@v4',with:{path:'dist'}}]},...Object.fromEntries(['deploy','release'].map(j=>[j,{'runs-on':'ubuntu-latest',needs:'build',if:"github.event_name == 'workflow_dispatch' && inputs.confirm == true",steps:[{run:'echo "模拟完成"'}]}]))}});
test('流水线真值表拒绝OR、默认开启、依赖缺失和非模拟部署',()=>{
 assert.ok(all(workflowChecks(stringify(workflow()))));
 for(const change of [w=>w.jobs.deploy.if=w.jobs.deploy.if.replace('&&','||'),w=>w.on.workflow_dispatch.inputs.confirm.default=true,w=>delete w.jobs.release.needs,w=>w.jobs.release.steps[0].run='echo $(curl example.com)',w=>w.jobs.build.steps.pop()]){
  const w=workflow();change(w);assert.ok(!all(workflowChecks(stringify(w))));
 }
});
test('架构图校验实际节点、方向和禁止直连',()=>{
 const m='flowchart LR\n'+Object.entries({browser:'浏览器',gateway:'API网关',orders:'订单服务',db:'PostgreSQL',cache:'Redis',queue:'消息队列',notify:'通知服务'}).map(([k,v])=>`${k}[${v}]`).join('\n')+'\nbrowser-->gateway\ngateway-->orders\norders-->db\norders-->cache\norders-->queue\nqueue-->notify';
 assert.ok(all(diagramChecks(m)));assert.ok(!all(diagramChecks(m.replace('queue-->notify','notify-->queue'))));assert.ok(!all(diagramChecks(m+'\nbrowser-->db')));
});
const zip=files=>zipSync(Object.fromEntries(Object.entries(files).map(([n,v])=>[n,strToU8(v)])));
test('归档与PPT检查拒绝缺文件、缺页、错误满意率和非16比9',()=>{
 const skill={'text-brief/SKILL.md':'---\nname: text-brief\ndescription: 根据提供文字生成摘要，不编造事实\n---\n输入文字、摘要和待确认信息；不得编造日期。','text-brief/references/example.md':'金星计划延期，上线日期待定。'};
 assert.ok(all(skillArchiveChecks(zip(skill))));assert.ok(!all(skillArchiveChecks(zip({'text-brief/SKILL.md':skill['text-brief/SKILL.md']}))));assert.throws(()=>zipTextFiles(zip({'../evil.md':'bad'})),/越界/);
 const files={'[Content_Types].xml':'<Types/>','ppt/presentation.xml':'<p:presentation><p:sldIdLst>'+[1,2,3,4].map(i=>`<p:sldId id="${i}"/>`).join('')+'</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>'};
 ['青禾便民服务试点复盘','触达120人、问卷96份、满意84份、满意率87.5%','高峰期排队，预约分流','林溪2026年11月6日原型，周言2026年11月10日测试'].forEach((t,i)=>files[`ppt/slides/slide${i+1}.xml`]=`<p:sld><a:t>${t}</a:t></p:sld>`);
 assert.ok(all(pptChecks(zip(files))));assert.ok(!all(pptChecks(zip({...files,'ppt/slides/slide2.xml':files['ppt/slides/slide2.xml'].replace('87.5%','70%')}))));
 assert.ok(!all(pptChecks(zip({...files,'ppt/presentation.xml':files['ppt/presentation.xml'].replace('12192000','9000000')}))));delete files['ppt/slides/slide4.xml'];assert.ok(!all(pptChecks(zip(files))));
});
test('产物路径校验阻止引用其他运行目录',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-artifact-test-'));await fs.mkdir(path.join(dir,'outputs'));await fs.writeFile(path.join(dir,'old.txt'),'old');
 await assert.rejects(()=>readArtifact(path.join(dir,'outputs'),'../old.txt'),/越出/);
});
test('网站实际筛选与移动适配，图标同图异名不能通过',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-preview-test-'));
 const site=`<h1>青禾共享书房</h1><nav>首页 活动 联系</nav><input type="search" aria-label="搜索书籍"><select aria-label="分类"><option>全部</option><option>技术</option><option>文学</option></select><div data-book data-category="技术">JavaScript基础</div><div data-book data-category="文学">城市散步</div><div data-book data-category="技术">Python入门</div><script>const s=document.querySelector('input'),c=document.querySelector('select');function filter(){document.querySelectorAll('[data-book]').forEach(e=>e.hidden=!e.textContent.includes(s.value)||(c.value!=='全部'&&e.dataset.category!==c.value))}s.oninput=filter;c.onchange=filter;</script>`;
 await fs.writeFile(path.join(dir,'index.html'),site);assert.ok(all(await previewChecks(11,dir,async()=>{})));
 await fs.writeFile(path.join(dir,'index.html'),site.replace('s.oninput=filter;c.onchange=filter;',''));assert.ok(!all(await previewChecks(11,dir,async()=>{})));
 const svg=(id,d)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path id="${id}" d="${d}"/></svg>`;
 for(const [n,d] of [['home','M2 12L12 2L22 12V22H2Z'],['add','M12 2V22M2 12H22'],['success','M2 12L10 20L22 4']])await fs.writeFile(path.join(dir,n+'.svg'),svg(n,d));
 await fs.writeFile(path.join(dir,'视觉规范.md'),'导航、操作、状态；尺寸24px、线宽2px、颜色currentColor');assert.ok(all(await previewChecks(14,dir,async()=>{})));
 await fs.writeFile(path.join(dir,'success.svg'),svg('another-name','M12 2V22M2 12H22'));assert.ok(!all(await previewChecks(14,dir,async()=>{})));
});
test('模拟真实场景自动填充、不提前发送、消息延迟落盘和草稿保护',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage(),definition=getClientCase(3);await page.setContent(`<main><button>新建任务</button><button>日常办公</button><button>默认工作空间</button><button id="scene">邮件处理 未生效</button><div contenteditable="true"></div><button onclick="window.sent=true">运行任务</button></main><script>document.querySelector('#scene').onclick=()=>{const e=document.querySelector('[contenteditable]');e.textContent='帮我起草一封专业的工作邮件。';const s=document.createElement('span');s.setAttribute('data-skill-remove','email-official');s.textContent='email-official';e.prepend(s);}</script>`);
  const assertions=[],owned=await fillScenario(page,definition,normalizeConfig(),{assert:(name,pass)=>assertions.push(pass)});assert.ok(assertions.every(Boolean));assert.equal(await page.evaluate(()=>window.sent),undefined);
  assert.equal(await clearOwnedDraft(page,owned),true);await fillScenario(page,definition,normalizeConfig());
  await page.locator('[contenteditable]').fill('用户刚写的草稿');assert.equal(await clearOwnedDraft(page,owned),false);assert.equal(await page.locator('[contenteditable]').innerText(),'用户刚写的草稿');
  await assert.rejects(()=>fillScenario(page,definition,normalizeConfig()),/草稿/);
  await page.setContent('<div role="dialog">配置已更新，需要重新加载引擎<button onclick="window.cancelled=true;this.parentNode.remove()">取消</button><button>立即终止并生效</button></div>');
  await assert.rejects(()=>guardDialogs(page,{cancelReload:true}),/未终止/);assert.equal(await page.evaluate(()=>window.cancelled),true);
  const sid='ses_test123';await page.route('http://mock.local/**',route=>route.fulfill({contentType:'text/html',body:'<main>模拟会话</main>'}));await page.goto('http://mock.local/session/'+sid);
  await page.evaluate(sid=>{
   window.__reads=0;window.__OPENWORK_ELECTRON__={invokeDesktop:async()=>({baseUrl:'http://engine.local',opencodeUsername:'fixture',opencodePassword:'fixture-secret'})};
   window.fetch=async url=>({ok:true,status:200,json:async()=>url.includes('/message')?(++window.__reads===1?[]:[{info:{role:'user',sessionID:sid},parts:[{type:'text',text:'完整文字材料'}]}]):{id:sid}});
  },sid);
  assert.equal((await waitSentInput(page,sid,'完整文字材料')).complete,true);
  await page.goto('http://mock.local/new');await page.evaluate(()=>{document.body.textContent='工作区准备失败 Workspace model runtime is unreachable';});
  await assert.rejects(()=>waitCreatedSession(page,'http://mock.local/new',{timeoutMs:1000}),/工作区准备失败/);
  assert.equal(finalAssistantText({messages:[{info:{role:'user'},parts:[{type:'text',text:'不能用用户输入断言'}]},{info:{role:'assistant'},parts:[{type:'tool'},{type:'text',text:'中间工具消息'}]},{info:{role:'assistant'},parts:[{type:'text',text:'仅最终回复'}]}]}),'仅最终回复');
 }finally{await browser.close();}
});
test('控制台允许两个独立配置并行，不覆盖报告或会话快照',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-parallel-test-'));process.env.MW_FIXTURE_DIR=dir;
 const {server,url}=await createConsole({port:0,dataDir:dir});
 try{
  const s=await fetch(url+'/api/state').then(r=>r.json()),post=(route,data)=>fetch(url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':s.token},body:JSON.stringify(data)});
  const entry=await post('/api/scripts',{path:path.join(projectRoot,'local-console/fixture-script.mjs')}).then(r=>r.json());
  const ids=[];for(const question of ['first','second']){const r=await post('/api/run',{scriptId:entry.id,config:{question}});assert.equal(r.status,202);ids.push((await r.json()).id);}
  assert.equal((await fetch(url+'/api/state').then(r=>r.json())).active,2);
  let jobs;for(let i=0;i<50;i++){jobs=await Promise.all(ids.map(id=>fetch(url+'/api/jobs/'+id).then(r=>r.json())));if(jobs.every(j=>j.status==='PASS'))break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(jobs.every(j=>j.status==='PASS'));assert.notEqual(jobs[0].reportPath,jobs[1].reportPath);assert.deepEqual(jobs.map(j=>j.result.config.question),['first','second']);
 }finally{await new Promise(r=>server.close(r));delete process.env.MW_FIXTURE_DIR;}
});
