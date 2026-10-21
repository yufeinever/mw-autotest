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
test('日程功能按实际安排与优先顺序判断，拒绝仅复述要求或无关回复',()=>{
 // Excerpt from the 1020-2321 false negative; keep regression portable.
 const actual='## 本周工作日程与优先级\n优先级规则：本周必须交付、影响他人或有明确截止时间的事项。\n按天安排：10月21日 周三，完成最紧急、最接近截止的交付事项。\n每天2小时建议拆分：前10分钟确认当天唯一核心目标；接下来80分钟连续深度工作；最后30分钟检查、整理、提交。';
 assert.ok(all(textChecks(1,actual)),'真实逐日安排和时间分配应通过');
 assert.ok(all(textChecks(1,'本周计划：周三上午完成核心交付，周四下午处理反馈。优先保障临近截止事项。')));
 for(const wrong of ['帮我规划本周的工作日程与优先级。','今天推荐红烧肉和番茄汤。','请提供任务，我将为你规划日程。','请把本周要完成的事项、各自截止时间，以及固定会议或不可用时段发给我。我会按 **10月19日—25日** 安排日程并排序优先级。'])assert.ok(!all(textChecks(1,wrong)));
 const schedule='工作日程安排：周一完成项目方案，周二整理客户反馈，周五提交周报。优先处理截止时间近的项目方案。';
 assert.ok(all(textChecks(1,schedule,{scheduleFixture:true})));assert.ok(!all(textChecks(1,schedule.replace('客户反馈','无关事项'),{scheduleFixture:true})));
});
test('正文和表格不必附JSON，等价时间、图布局和节点ID有效',()=>{
 assert.ok(all(textChecks(3,'主题：星桥项目评审改期通知\n项目组各位：2026年11月3日由下午2点改为下午3点半，三楼A会议室。请2026年11月2日下午6点前确认。许晴')));
 assert.ok(all(textChecks(3,'主题：星桥项目评审改期通知\n项目组各位：2026年11月3日由下午两点改为下午三点半，三楼A会议室。请2026年11月2日下午六点前确认。许晴')));
 const creative='## 通勤上班族：邻里快借\n下班借用工具，预约和归还提醒，以时间匹配为特点。\n## 亲子家庭：成长交换\n周末交换玩具，发布需求和年龄匹配，关注儿童成长。\n## 银发居民：上门互助\n邻里借用家用品，代取和上门归还，减少出行。';
 assert.ok(all(textChecks(13,creative)));assert.ok(!all(textChecks(13,'上班族、儿童家庭、老年居民')));
 assert.ok(all(textChecks(13,creative.replace('通勤上班族：','快取邻居｜通勤上班族：').replace('亲子家庭：','成长换物圈｜亲子家庭：').replace('银发居民：','熟人帮｜银发居民：'))),'标题分隔竖线不是表格');
 assert.ok(!all(textChecks(13,['上班族','亲子家庭','老年居民'].map(g=>'## '+g+'\n邻里借用工具，预约与归还提醒。').join('\n'))),'不能只换人群标题而复用相同方案');
 const labeled=[['邻里闪借','上班族','下班临时借用电钻，附近筛选、快速预约与归还。'],['成长循环箱','儿童家庭','成长阶段交换绘本，年龄匹配与家庭清单发布。'],['熟邻帮帮站','老年居民','借用推车，大字语音发布、邻里代取和线下登记。']].map(([title,group,body])=>'## '+title+'\n- **目标人群：**'+group+'\n'+body).join('\n');
 const recommendation='\n**初步建议：**上班族、儿童家庭和老年居民按社区特征选择。';
 assert.ok(all(textChecks(13,labeled+recommendation)),'末尾同时提及三组的建议不能替代三个实际方案段落');
 const repeated=['上班族','儿童家庭','老年居民'].map((g,i)=>'## 方案'+i+'\n- **目标人群：**'+g+'\n邻里借用工具，预约与归还提醒。').join('\n');
 assert.ok(!all(textChecks(13,repeated)),'人群标签不同不能使重复内容变成差异化方案');
 assert.ok(!all(textChecks(13,repeated+recommendation)),'共同建议不能使最后一个重复方案变成差异化内容');
 const named='三类人群：\n1. 上班族\n2. 儿童家庭\n3. 老年居民\n'+[['上班族','下班借用工具，预约和归还提醒。'],['儿童家庭','成长阶段交换绘本，年龄匹配与家庭清单发布。'],['老年居民','借用推车，邻里代取和线下登记。']].map(([g,b],i)=>'# 方案'+(i+1)+'：产品名\n## 定位\n面向'+g+'。\n## 核心功能\n'+b).join('\n')+'\n# 比较\n|核心人群|上班族|儿童家庭|老年居民|\n|---|---|---|---|\n|体验|快|成长|信任|';
 assert.ok(all(textChecks(13,named)),'概要人群列表和简略比较表不能替代实际方案');
 assert.ok(!all(textChecks(13,named.replace('借用推车，邻里代取和线下登记。','待定'))),'概要和其他方案不能掩盖缺失功能');
 const shop='虚构测试快照\n|候选|结论|原因|\n|A 云杉Air|推荐|满足预算、重量和容量要求|\n|B 远行Pro|推荐|满足全部硬条件|\n|C 旗舰Max|剔除|价格超预算|\n|D 力量Book|剔除|重量超限|\n|E 轻享Go|剔除|内存与SSD不足|';
 assert.ok(all(textChecks(16,shop)));assert.ok(!all(textChecks(16,shop.replace('C 旗舰Max|剔除|价格超预算','C 旗舰Max|推荐|性能优秀'))));
 const paragraphs='以下为虚构测试快照。\n## A 云杉Air\n推荐，满足全部条件。\n## B 远行Pro\n推荐，预算重量容量达标。\n## C 旗舰Max\n剔除：价格超预算。\n## D 力量Book\n剔除：重量超限。\n## E 轻享Go\n不推荐：内存和SSD不足。';
 assert.ok(all(textChecks(16,paragraphs)),'理由可以写在产品标题下一行');
 assert.ok(!all(textChecks(16,paragraphs.replace('价格超预算','重量超限'))),'理由仍须对应候选短板');
 const mixed='推荐云杉Air和远行Pro。\n### 推荐\n|产品|结论|\n|---|---|\n|云杉Air|优先推荐，比远行Pro更轻|\n|远行Pro|符合条件，作为备选|\n### 剔除\n- 旗舰Max：8999元，超过8000元预算上限。\n- 力量Book：1.65kg，超过1.4kg重量上限。\n- 轻享Go：内存8GB、SSD256GB低于要求。\n说明：虚构测试快照。';
 assert.ok(all(textChecks(16,mixed)),'允许推荐表格与剔除列表混排，继承剔除分组且按产品列匹配');
 assert.ok(all(textChecks(16,mixed.replace('### 剔除','**剔除产品**'))),'加粗分组标题与Markdown标题等价');
 assert.ok(!all(textChecks(16,mixed.replace('旗舰Max：8999','旗舰Max：推荐，8999'))),'剔除标题不能覆盖明确推荐不合格商品的矛盾');
 const research='|维度|Codex|Claude Code|WorkBuddy|\n|功能|代码|代码|办公|\n|上手门槛|CLI|CLI|客户端|\n|成本|未核实|未核实|未核实|\n|场景|修改仓库|修改仓库|办公任务|\n|优势|代码任务|开发工具|办公协作|\n|局限|需审查|需审查|需审查|\n建议Windows团队先试点。来源：https://developers.openai.com/codex/ https://code.claude.com/docs https://www.workbuddy.cn/docs/workbuddy/Overview';
 assert.ok(all(textChecks(15,research)),'接受按产品分列的对照表');
 assert.ok(!all(textChecks(15,research.replace('|局限|需审查|需审查|需审查|','|局限|需审查|需审查||'))),'不能以别的产品内容替代缺失维度');
 const diagram='graph TD\nA(浏览器) --> B[API网关] --> C[订单服务]\nC --> D[(PostgreSQL数据库)]\nC --> E[(Redis缓存)]\nC -->|消息| F[消息队列] --> G(通知服务)';
 assert.ok(all(diagramChecks(diagram)));assert.ok(!all(diagramChecks(diagram.replace('F[消息队列] --> G(通知服务)','G(通知服务) --> F[消息队列]'))));
});
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
  await page.evaluate(()=>document.querySelector('main').insertAdjacentHTML('afterbegin','<button aria-label="权限">默认权限</button>'));
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
test('控制台接受两个独立配置并串行排队，不覆盖报告或会话快照',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-parallel-test-'));process.env.MW_FIXTURE_DIR=dir;
 const {server,url}=await createConsole({port:0,dataDir:dir});
 try{
  const s=await fetch(url+'/api/state').then(r=>r.json()),post=(route,data)=>fetch(url+route,{method:'POST',headers:{'content-type':'application/json','x-console-token':s.token},body:JSON.stringify(data)});
  const entry=await post('/api/scripts',{path:path.join(projectRoot,'local-console/fixture-script.mjs')}).then(r=>r.json());
  const ids=[];for(const question of ['first','second']){const r=await post('/api/run',{scriptId:entry.id,config:{question}});assert.equal(r.status,202);ids.push((await r.json()).id);}
  const queuedState=await fetch(url+'/api/state').then(r=>r.json());assert.equal(queuedState.active,2);
  assert.ok(queuedState.jobs.filter(j=>j.status==='RUNNING').length<=1);
  let jobs;for(let i=0;i<50;i++){jobs=await Promise.all(ids.map(id=>fetch(url+'/api/jobs/'+id).then(r=>r.json())));if(jobs.every(j=>j.status==='PASS'))break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(jobs.every(j=>j.status==='PASS'));assert.notEqual(jobs[0].reportPath,jobs[1].reportPath);assert.deepEqual(jobs.map(j=>j.result.config.question),['first','second']);
 }finally{await new Promise(r=>server.close(r));delete process.env.MW_FIXTURE_DIR;}
});
