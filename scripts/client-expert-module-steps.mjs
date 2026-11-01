import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseDocument} from 'yaml';
import {workspaces} from './mobilework-workspaces.mjs';
import {readInstalledSkills,settleSkillReload} from './mobilework-skill-resources.mjs';
import {openExpertWorkspace,marketCard} from './mobilework-market-ui.mjs';
import {restoreModuleNavigation} from './mobilework-module-navigation.mjs';
import {snapshotDraft} from './mobilework-isolation.mjs';
import {inspectModuleHandoff} from './mobilework-module-handoff.mjs';
import {selectNativeFolder} from './mobilework-native-folder.mjs';
import {readLocalSkill,readCustomToolRegistry,releaseManagedSkills,releaseCustomTool} from './mobilework-module-resources.mjs';
import {withMarketExpert} from './mobilework-recording-expert.mjs';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
import {buildTrace} from '../local-console/trace.mjs';
import {readArtifact} from './client-case-checks.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const button=(page,name)=>page.getByRole('button',{name,exact:true}).filter({visible:true});
const completedTools=data=>data.messages.flatMap(m=>(m.parts||[]).filter(p=>p.type==='tool'&&p.state?.status==='completed'));
const skillMetadata=content=>parseDocument(content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1]||'').toJS();

export async function runExpertModuleSteps(context){
 const {number,page,config,control,resources,dir,remaining,assert,capture,log,send,checkpointPage,checkpointResources,getData,saveTrace}=context;
 const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
 const finish=step=>remaining.delete(step);
 const workspaceId=page.url().match(/\/workspace\/([^/]+)/)[1],workspace=(await workspaces(page)).items.find(w=>w.id===workspaceId);
 const adoptHandoff=async()=>{
  await page.waitForURL(url=>url.hash==='#/session'||url.hash==='#/workspace/'+workspaceId+'/session',{timeout:60000,waitUntil:'commit'});
  const draft=await inspectModuleHandoff(page,resources);
  if(!draft)throw blocked('模块任务交接未匹配本轮登记');
  delete resources.moduleNavigation;await checkpointPage(draft);return draft;
 };
 const waitUntil=async(predicate,message)=>{
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){if(await predicate())return;await page.waitForTimeout(300);}
  throw blocked(message);
 };

 if(number===92){
  // The original skill is an example. Use the actual installed browser skill
  // whose detail page and Try action have been observed in this client.
  const skill='playwright-mcp';
  if(!(await readInstalledSkills(page,workspace.path)).includes(skill))throw blocked('本条选用的已安装浏览器技能playwright-mcp不存在');
  await openExpertWorkspace(context,{section:'技能',targetHash:'#/experts/skills',handoff:{kind:'skill-trial',value:skill,workspaceId}});
  await page.getByRole('button',{name:/^已安装技能\(/}).click();
  await marketCard(page,skill).click();
  await page.getByRole('heading',{name:skill,exact:true}).waitFor();await capture('已安装浏览器技能详情');finish('已安装技能真实详情');
  await button(page,'打开'+skill+'更多操作').click();
  const trial=page.getByRole('menuitem',{name:'去试试',exact:true});
  if(await trial.getAttribute('aria-disabled')==='true')throw blocked('当前技能试用不可用，保留既有技能开关；需先启用并完成生效');
  await trial.click();const draft=await adoptHandoff();
  assert('详情去试试真实交接并默认选择目标Skill',draft.skills.includes(skill),draft.skills);finish('去试试交接及默认选择');await capture('试用交接默认技能');
  await send('请使用已选playwright-mcp技能真实打开 https://www.baidu.com/ ，读取当次网页标题，并把实际网址与标题写入本任务目录“浏览器试用结果.txt”。只浏览公开首页，不登录、不搜索个人信息、不安装新依赖；技能或浏览器未就绪请如实说明。');
  const data=getData(),trace=buildTrace(data,{expectedSkills:[skill]});
  assert('所选浏览器Skill在本Session实际加载成功',trace.checks[0].pass,trace.checks[0].actual);finish('本Session真实Skill调用');
  const navigation=completedTools(data).filter(p=>/browser|navigate|网页|浏览器/i.test(p.tool+' '+JSON.stringify(p.state.input))&&/baidu\.com/.test(JSON.stringify(p.state.input)));
  await save('浏览器实际执行证据.json',navigation);
  assert('实际浏览工具完成百度访问并返回页面证据',navigation.some(p=>/百度|baidu/i.test(String(p.state.output))));
  const text=await readArtifact(control.directory,'浏览器试用结果.txt');await fs.writeFile(path.join(dir,'浏览器试用结果.txt'),text);
  assert('本次真实产物保留实际百度域名和标题',/baidu\.com/.test(text)&&/百度/.test(text));finish('真实网页访问与产物');
  await saveTrace();return;
 }

 if(number===93){
  const suffix=randomUUID().slice(0,8),marker='MW-AUTOTEST-093-'+suffix,importId='mw-autotest-import-'+suffix,createdId='mw-autotest-created-'+suffix;
  const folder=path.join(dir,'输入材料',importId);await fs.mkdir(folder,{recursive:true});
  const source='---\nname: '+importId+'\ndescription: 仅对用户提供的合成会议材料列出事项与缺失信息，不访问外部资源。\n---\n\n# 合成会议事项整理\n\n来源：'+marker+'\n\n输入：用户提供的合成会议文字。\n输出：事项、责任人、截止日期；原文未给出的字段写待确认，不编造事实。不联网，不修改文件，不发送消息。\n';
  await fs.writeFile(path.join(folder,'SKILL.md'),source);
  const before=await readInstalledSkills(page,workspace.path);
  resources.managedSkills={projectDir:workspace.path,installedBefore:before,ids:[importId,createdId],marker,pending:false,pendingKind:'import'};await checkpointResources();
  let failure;
  try{
   await openExpertWorkspace(context,{section:'技能',targetHash:'#/experts/skills',handoff:{kind:'skill-create',value:'mobilework-skill-creator',workspaceId}});
   await button(page,'添加技能').click();await page.getByRole('menuitem',{name:'上传技能',exact:true}).click();
   // The modal uses a native directory dialog, rather than an HTML file input.
   await selectNativeFolder(page,{folder,dir,control,log,open:()=>button(page,'选择文件夹').click()});
   await page.getByText(importId,{exact:true}).filter({visible:true}).waitFor();await capture('上传技能原生目录已选择');finish('真实原生目录选择');
   resources.managedSkills.pending=true;await checkpointResources();await button(page,'导入').click();
   await waitUntil(async()=> (await readInstalledSkills(page,workspace.path)).includes(importId),'合成技能导入尚未完成');
   await settleSkillReload(page);
   await page.getByRole('heading',{name:'上传技能',exact:true}).waitFor({state:'hidden'});
   resources.managedSkills.pending=false;await checkpointResources();
   const imported=await readLocalSkill(page,workspace.path,importId);await fs.writeFile(path.join(dir,'导入后SKILL.md'),imported.content);
   assert('真实导入后名称及内容与合成源一致',skillMetadata(imported.content)?.name===importId&&imported.content.replace(/\r\n/g,'\n')===source);finish('导入真实目录及内容');await capture('合成技能导入完成');
   const creator=await page.evaluate(async projectDir=>{const invoke=window.__MOBILEWORK__.invoke,auth=await invoke('auth:current');const {value}=await invoke('store:read',{accountId:auth.account.id,path:'skills/registry.json',fallback:{}});return {inspection:await invoke('engine:inspectSkillPackage',{projectDir,id:'mobilework-skill-creator'}),enabled:value['mobilework-skill-creator']?.enabled===true};},workspace.path);
   await save('技能创建器前置.json',creator);
   if(!creator.enabled||!creator.inspection.installed||!creator.inspection.valid||!creator.inspection.aligned)throw blocked('技能创建器未完整就绪；本条不覆盖用户已有创建器配置，需准备后重试创建分支');
   await button(page,'添加技能').click();await page.getByRole('menuitem',{name:'创建技能',exact:true}).click();
   const draft=await adoptHandoff();assert('创建技能入口真实交接并自动填入创建提示',/创建.*skill|创建.*技能/i.test(draft.text),draft.text);finish('创建入口自动填充及交接');await capture('创建技能自动填充');
   resources.managedSkills.pending=true;resources.managedSkills.pendingKind='create';await checkpointResources();
   await send('请创建并安装一个本地Skill，精确名称为 '+createdId+'，只整理用户提供的合成会议文本，输出事项、责任人、截止日期；缺失字段写“待确认”，禁止编造事实，不联网、不发消息。SKILL.md正文必须保留来源标记 '+marker+'。请使用当前已准备好的MobileWork技能创建器实际生成并安装，不只输出建议或Markdown；不要更改已有技能。完成后保留实际SKILL.md路径。');
   await control.acquire(page,'EVIDENCE');resources.managedSkills.pending=false;await checkpointResources();
   const installed=await readInstalledSkills(page,workspace.path);await save('创建后实际技能目录.json',{before,after:installed,importId,createdId});
   assert('自然语言创建后实际安装指定新技能',installed.includes(createdId));
   const created=await readLocalSkill(page,workspace.path,createdId);await fs.writeFile(path.join(dir,'本轮创建SKILL.md'),created.content);
   const meta=skillMetadata(created.content);
   assert('真实新技能元数据和来源对应本轮',meta?.name===createdId&&typeof meta.description==='string'&&meta.description.trim()&&created.content.includes(marker));
   assert('技能说明包含输入输出和事实边界',/会议|文本/.test(created.content)&&/事项/.test(created.content)&&/责任人/.test(created.content)&&/截止|日期/.test(created.content)&&/待确认/.test(created.content)&&/不.{0,6}(?:编造|虚构)|禁止.{0,6}编造/.test(created.content));finish('真实新技能及内容核对');
   const trace=buildTrace(getData(),{expectedSkills:['mobilework-skill-creator']});
   assert('创建器有本Session实际调用证据',trace.checks[0].pass,trace.checks[0].actual);finish('技能创建器真实调用');await saveTrace();
  }catch(error){failure=error;await capture('技能上传创建异常现场').catch(e=>log('异常截图失败',e.message));}
  finally{
   try{
    if(resources.managedSkills&&!resources.managedSkills.pending){await releaseManagedSkills(page,resources.managedSkills);delete resources.managedSkills;await checkpointResources();finish('仅清理本轮新增技能');}
   }catch(error){log('合成技能收尾未完成',error.message);if(failure)failure.message+='；收尾：'+error.message;else failure=error;}
  }
  if(failure)throw failure;return;
 }

 if(number===94){
  const engine=await readEngineConnection(page),states=await engineRequest(engine,'/mcp?directory='+encodeURIComponent(workspace.path));
  const candidates=await page.evaluate(async()=>{const data=await window.__MOBILEWORK__.invoke('mcp:list');return Object.entries(data.servers).filter(([,v])=>v.custom?.name==='腾讯文档').map(([id,v])=>({id,name:v.custom.name,configured:Boolean(v.server),enabled:v.server?.enabled===true}));});
  await save('业务工具真实前置.json',{candidates,statuses:candidates.map(c=>({id:c.id,status:states[c.id]?.status}))});
  if(candidates.length!==1||!candidates[0].configured||states[candidates[0].id]?.status!=='connected')throw blocked('原表腾讯文档工具未配置并连接；未使用合成无效密钥冒充业务鉴权成功，需准备后执行');
  const target=candidates[0];finish('真实业务工具配置与连接');
  await button(page,'工具').click();
  const row=page.locator('span.truncate').filter({visible:true,hasText:/^腾讯文档$/}).locator('xpath=..'),toggle=row.getByRole('switch');await toggle.waitFor();
  const baseline=await toggle.getAttribute('aria-checked')==='true';
  resources.toolSelection={name:'腾讯文档',baseline};await checkpointResources();
  if(!baseline)await toggle.click();
  assert('任务工具面板真实选择腾讯文档',await toggle.getAttribute('aria-checked')==='true');await page.keyboard.press('Escape');await capture('业务工具真实选中');finish('真实工具任务选择');
  await send('请仅使用已选腾讯文档工具，读取我有权限查看的文档列表，最多列出前5份的实际标题和文档链接，写入本任务目录“腾讯文档列表.json”，格式为数组，每项title、url；如果没有文档保存空数组并说明。只读，不创建、修改、删除或分享文档。鉴权失败请如实报告。');
  const calls=completedTools(getData()).filter(p=>p.tool.startsWith(target.id+'_')||p.tool.startsWith(target.id+'-')||p.state?.metadata?.serverName===target.id);
  await save('腾讯文档实际调用.json',calls);
  assert('实际调用已选择的腾讯文档工具且返回成功',calls.length>0&&calls.some(p=>!p.state.error&&!/invalid.api.key|unauthorized|鉴权失败|认证失败/i.test(String(p.state.output))));finish('本Session业务工具真实调用');
  const text=await readArtifact(control.directory,'腾讯文档列表.json'),list=JSON.parse(text);
  assert('真实产物为文档列表且每项有标题及链接',Array.isArray(list)&&list.length<=5&&list.every(item=>typeof item.title==='string'&&item.title.trim()&&/^https?:\/\//.test(item.url)));
  const outputs=calls.map(p=>String(p.state.output)).join('\n');
  assert('列表内容与工具实际返回一致',list.length?list.every(item=>outputs.includes(item.title)&&outputs.includes(item.url)):/\[\s*\]|total[^\d]*0|暂无|没有.*文档/.test(outputs));
  await fs.writeFile(path.join(dir,'腾讯文档列表.json'),text);finish('实际业务返回与产物一致');await saveTrace();return;
 }

 if(number===95){
  const suffix=randomUUID().slice(0,8),name='MW-AUTOTEST-095-'+suffix,renamed=name+'-改名',url='http://127.0.0.1:9/mw-autotest';
  const baseline=await readCustomToolRegistry(page,workspaceId);
  resources.customTool={name,renamed,url,workspaceId,projectDir:workspace.path,accountId:baseline.accountId,globalHashes:baseline.globalHashes,accountHashes:baseline.accountHashes,id:null};await checkpointResources();
  await openExpertWorkspace(context,{section:'工具',targetHash:'#/experts/connectors'});await button(page,'我的工具').click();
  await page.getByRole('button',{name:/^(创建|创建工具)$/}).filter({visible:true}).click();
  const form=page.locator('div.fixed.inset-0').filter({has:page.getByRole('heading',{name:'自定义工具',exact:true})});
  await form.locator('input[placeholder="例如：企业内部 ERP"]').fill(name);
  await form.locator('input[placeholder="https://api.example.com/mcp"]').fill(url);
  await form.locator('textarea').fill('仅验证本轮工具定义的保存与改名，不连接或调用。');
  await form.getByRole('button',{name:'提交',exact:true}).click();await form.waitFor({state:'hidden'});
  let registered;
  await waitUntil(async()=>{registered=(await readCustomToolRegistry(page,workspaceId)).targets.filter(t=>t.name===name&&!Object.hasOwn(baseline.accountHashes,t.id));return registered.length===1;},'新建本轮工具未对应唯一账户登记');
  resources.customTool.id=registered[0].id;await checkpointResources();finish('本轮独立工具定义准备');await capture('本轮工具创建完成');
  const more=button(page,'打开'+name+'更多操作');await more.click();await page.getByRole('menuitem',{name:'修改工具',exact:true}).click();
  const edit=page.locator('div.fixed.inset-0').filter({has:page.getByRole('heading',{name:'修改工具',exact:true})});await edit.waitFor();
  assert('修改表单回填本轮原名及地址',await edit.locator('input[placeholder="例如：企业内部 ERP"]').inputValue()===name&&await edit.locator('input[placeholder="https://api.example.com/mcp"]').inputValue()===url);finish('真实修改入口及回填');
  await edit.locator('input[placeholder="例如：企业内部 ERP"]').fill(renamed);await edit.locator('textarea').fill('本轮修改已保存-'+suffix);await capture('本轮工具改名保存前');
  await edit.getByRole('button',{name:'保存',exact:true}).click();await edit.waitFor({state:'hidden'});await button(page,'打开'+renamed+'更多操作').waitFor();
  await page.reload({waitUntil:'commit'});await button(page,'我的工具').click();await button(page,'打开'+renamed+'更多操作').waitFor();
  const actual=(await readCustomToolRegistry(page,workspaceId)).targets.find(t=>t.id===resources.customTool.id);await save('自定义工具修改实际结果.json',{before:registered[0],after:actual});
  assert('同ID工具改名和描述持久化且未连接',actual?.name===renamed&&actual.description==='本轮修改已保存-'+suffix&&actual.mcp.url===url&&!actual.connected&&!actual.mcp.hasCredentials);finish('真实持久化与同ID核对');
  await button(page,'打开'+renamed+'更多操作').click();await page.getByRole('menuitem',{name:'修改工具',exact:true}).click();
  assert('重开修改表单回填持久化新值',await edit.locator('input[placeholder="例如：企业内部 ERP"]').inputValue()===renamed&&await edit.locator('textarea').inputValue()==='本轮修改已保存-'+suffix);
  await edit.getByRole('button',{name:'取消',exact:true}).click();await capture('修改持久化后');
  await releaseCustomTool(page,resources.customTool);delete resources.customTool;await checkpointResources();finish('本轮工具清理及原有配置隔离');
  await restoreModuleNavigation(page,resources);await checkpointPage();return;
 }

 if(number===96){
  await withMarketExpert(context,'AIPPT专家',async({catalog})=>{
   const target=catalog.find(e=>e.name==='AIPPT专家');finish('真实专家市场召唤与选择');
   await send('请由已选择的AIPPT专家完成“如何培养一个好习惯”的PPT大纲模板。只需大纲，不需要生成PPT或登录外部平台；在本任务目录保存“好习惯PPT大纲.md”，设计4到6页，每页有标题、至少两条可执行要点及呈现建议，覆盖小目标、触发条件、执行安排和复盘调整。示例为虚构学习习惯，不编造研究数据或名人引述。');
   const data=getData(),trace=buildTrace(data),agent=target.primaryAgentId||target.slug;
   const routed=data.messages.some(m=>m.info?.role==='assistant'&&(m.info.agent===agent||m.info.agent?.startsWith(agent+'-')))||data.session?.agent===agent;
   const skillCalls=trace.events.filter(e=>e.skill?.success&&(e.skill.id===agent||e.skill.id.startsWith(agent+'-')));
   await save('专家实际路由证据.json',{expert:{id:target.id,slug:target.slug,primaryAgentId:target.primaryAgentId},sessionAgent:data.session?.agent,assistantAgents:[...new Set(data.messages.filter(m=>m.info?.role==='assistant').map(m=>m.info.agent))],skills:skillCalls.map(e=>({sessionId:e.sessionId,tool:e.tool,skill:e.skill.id,status:e.status}))});
   assert('实际会话或专家专属Skill证明AIPPT专家参与执行',routed||skillCalls.length>0);finish('真实专家执行归属');
   const outline=await readArtifact(control.directory,'好习惯PPT大纲.md');await fs.writeFile(path.join(dir,'好习惯PPT大纲.md'),outline);
   const allHeadings=[...outline.matchAll(/^(#{1,4})\s+([^\n]+)$/gm)];
   const numbered=allHeadings.filter(h=>/第[一二三四五六\d]+页|(?:page|slide)\s*\d+|^\d+[.、：]/i.test(h[2]));
   const headings=numbered.length?numbered:([1,2,3,4].map(level=>allHeadings.filter(h=>h[1].length===level)).find(group=>group.length>=4&&group.length<=6)||[]);
   const sections=headings.map((heading,i)=>outline.slice(heading.index,headings[i+1]?.index??outline.length));
   assert('真实大纲包含4至6页可执行内容',sections.length>=4&&sections.length<=6&&sections.every(s=>s.split('\n').filter(l=>/^\s*(?:[-*]|\d+[.、])\s+/.test(l)).length>=2),{pages:sections.length});
   assert('大纲覆盖培养习惯的业务要点和呈现建议',/目标/.test(outline)&&/触发|提示|线索/.test(outline)&&/安排|执行|时间/.test(outline)&&/复盘|调整|回顾/.test(outline)&&/呈现|视觉|配图|图示|版式/.test(outline));finish('实际大纲产物及业务内容');
   await saveTrace();await control.acquire(page,'EVIDENCE');await capture('专家执行及真实大纲完成');
  });return;
 }
 throw Error('未接入的专家模块用例：'+number);
}
