import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {selectNativeFolder} from './mobilework-native-folder.mjs';
import {parseOwnedKnowledge} from './mobilework-knowledge-parse.mjs';
import {sameKnowledgePath} from './mobilework-knowledge-resources.mjs';
import {flattenKnowledgeFiles,observeKnowledgeSourceRows,sourceToolbarControls} from './mobilework-knowledge-source-ui.mjs';
import {openSources,refreshSources,checkSearchAndFilters} from './client-knowledge-source-steps.mjs';
import {prepareKnowledgeFormats,rawKnowledgeName,normalizedKnowledgeText,assessKnowledgeProgress} from './mobilework-knowledge-ingest.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const save=(dir,name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
const fingerprint=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceRow=(page,name)=>page.locator('[data-knowledge-source-node][role="button"]').filter({has:page.locator('span[title='+JSON.stringify(name)+']')});
const responseFor=(response,created,route,method='POST')=>response.request().method()===method&&new URL(response.url()).pathname==='/knowledge/'+created.id+route;

async function searchNames(context,call,created){
 const root=created.source_dir[0],folder=path.join(root,'模板演示目录');
 await fs.mkdir(folder,{recursive:true});
 await fs.copyFile(path.resolve('scripts/fixtures/client-upload-files/会议纪要.docx'),path.join(root,'模板演示说明.docx'));
 await fs.copyFile(path.resolve('scripts/fixtures/client-upload-files/项目进度.pdf'),path.join(root,'其他说明.pdf'));
 await fs.writeFile(path.join(folder,'目录内其他纪要.md'),'# 合成纪要\n\n仅供本条名称搜索，目录命中不等于其所有子文件名都命中。\n');
 await openSources(context.page,created,context);await refreshSources(context.page,call,created);
 await checkSearchAndFilters(context,call,created,{searchOnly:true,keywords:['模板演示','模板演示目录','无匹配-'+randomUUID().slice(0,8)],folderKeyword:'模板演示目录'});
}

async function importFolder(context,call,created){
 const {page,dir,control,log,assert,capture,remaining}=context;
 const folder=path.join(dir,'源目录导入-'+randomUUID().slice(0,8)),child=path.join(folder,'会议资料');
 await fs.mkdir(child,{recursive:true});
 await fs.writeFile(path.join(folder,'项目报告.md'),'# 源文件夹导入报告\n\n仅供测试的合成材料，权限仍待复核。\n');
 await fs.copyFile(path.resolve('scripts/fixtures/client-upload-files/会议纪要.docx'),path.join(child,'会议纪要.docx'));
 const inputs=[path.join(folder,'项目报告.md'),path.join(child,'会议纪要.docx')],before=await Promise.all(inputs.map(async file=>({path:file,sha256:fingerprint(await fs.readFile(file))})));
 await save(dir,'导入目录原材料.json',before);await openSources(page,created,context);
 const {buttons}=await sourceToolbarControls(page);
 const selected=await Promise.allSettled([
  page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/knowledge/add_source'&&r.request().postDataJSON().id===created.id,{timeout:60000}),
  selectNativeFolder(page,{folder,dir,control,log,open:()=>buttons.nth(4).click()})
 ]);
 for(const item of selected)if(item.status==='rejected')throw item.reason;
 const response=selected[0].value;
 const body=await response.json(),request=response.request().postDataJSON();
 await save(dir,'真实添加源目录请求.json',{request,httpStatus:response.status(),success:body.success});
 assert('原生选择目录经真实添加源目录请求被接受',response.ok()&&body.success==='true'&&sameKnowledgePath(request.source_dir,folder));remaining.delete('真实原生目录选择及添加请求');
 const actual=await call('/knowledge/'+created.id),tree=await call('/knowledge/'+created.id+'/source',{}),files=flattenKnowledgeFiles(tree);
 await save(dir,'添加后源目录和树.json',{actual,tree});
 assert('真实知识库源目录登记包含本轮选择目录',actual.source_dir.some(item=>sameKnowledgePath(item,folder)));
 assert('导入目录中全部嵌套文件被真实索引',inputs.every(file=>files.some(item=>sameKnowledgePath(item.path,file))));
 await observeKnowledgeSourceRows(page,files);
 await sourceRow(page,path.basename(folder)).waitFor();
 for(const file of inputs)await sourceRow(page,path.basename(file)).waitFor();
 await capture('原生导入源目录及全部嵌套文件');remaining.delete('目录原名及全部嵌套来源');
 assert('关联目录未改写原材料', (await Promise.all(before.map(async item=>fingerprint(await fs.readFile(item.path))===item.sha256))).every(Boolean));
 remaining.delete('实际源登记与原文件保护');
}

async function createAndEdit(context,call,created){
 const {page,dir,assert,capture,remaining}=context;
 await openSources(page,created,context);
 const root=sourceRow(page,path.basename(created.source_dir[0]));await root.waitFor();await root.hover();
 const actions=root.locator('span.ml-auto').getByRole('button');
 assert('实际源目录行提供新文件新目录和新增文件三个入口',await actions.count()===3);
 await actions.first().hover();const tooltip=page.locator('[data-slot="tooltip-content"][data-open]:not([data-closed])').filter({visible:true,hasText:"新建文件"});await tooltip.waitFor();
 assert('本轮实际新建文件入口已识别',/新建文件/.test(await tooltip.innerText()));
 const [response]=await Promise.all([page.waitForResponse(r=>responseFor(r,created,'/source/create-file')&&sameKnowledgePath(r.request().postDataJSON().parent_dir,created.source_dir[0])),actions.first().click()]);
 const body=await response.json(),createdFile=body.data;
 await save(dir,'真实新建源文件.json',{httpStatus:response.status(),...body});
 assert('真实新建文件默认未命名且位于本轮源目录',response.ok()&&body.success==='true'&&createdFile.name==='未命名.md'&&sameKnowledgePath(path.dirname(createdFile.path),created.source_dir[0]));
 assert('实际新建文件初始为空',await fs.readFile(createdFile.path,'utf8')==='');await capture('真实未命名源文件');remaining.delete('真实新建未命名文件');
 const editor=page.locator('.mw-wiki-editor .cm-content[contenteditable="true"]').filter({visible:true});await editor.waitFor();
 const marker='编辑留证-'+randomUUID(),content='这是本条合成源文档正文。\n\n'+marker+'\n\n权限功能仍待复核。';
 const [saved]=await Promise.all([page.waitForResponse(r=>responseFor(r,created,'/source/file','PUT')&&r.request().postDataJSON().content.includes(marker)),editor.fill(content)]);
 const savedBody=await saved.json();assert('真实编辑正文由产品保存成功',saved.ok()&&savedBody.success==='true'&&(await fs.readFile(createdFile.path,'utf8')).includes(marker));
 await capture('源文件正文真实保存');remaining.delete('真实正文编辑及保存');
 const title='知识源编辑-'+randomUUID().slice(0,8),markdown='# '+title+'\n\n'+content;
 const [renamed]=await Promise.all([page.waitForResponse(r=>responseFor(r,created,'/source/rename','PUT')&&r.request().postDataJSON().old_path===createdFile.path&&r.request().postDataJSON().new_name===title+'.md'),editor.fill(markdown)]);
 const renamedBody=await renamed.json();await save(dir,'标题同步真实重命名.json',{request:renamed.request().postDataJSON(),response:renamedBody});
 assert('编辑H1标题触发真实同源文件名同步',renamed.ok()&&renamedBody.success==='true');
 const actualFile=renamedBody.data.path;await sourceRow(page,title+'.md').waitFor();
 // The product debounces editor writes; observe its persisted content before reload.
 const deadline=Date.now()+10000;let text;
 do{text=await fs.readFile(actualFile,'utf8');if(text.includes('# '+title)&&text.includes(marker))break;await page.waitForTimeout(200);}while(Date.now()<deadline);
 await save(dir,'标题同步实际内容.json',{path:actualFile,text});
 assert('标题同步后真实文件保留H1和既有正文',text.includes('# '+title)&&text.includes(marker)&&text.includes('权限功能仍待复核'));
 const files=flattenKnowledgeFiles(await call('/knowledge/'+created.id+'/source',{}));
 assert('源列表仅保留新名而无遗留未命名文件',files.some(item=>sameKnowledgePath(item.path,actualFile))&&!files.some(item=>sameKnowledgePath(item.path,createdFile.path)));
 await openSources(page,created,context,{reload:true});await sourceRow(page,title+'.md').waitFor();await sourceRow(page,title+'.md').click();await editor.waitFor();
 assert('重载后真实编辑器内容仍持久化',(await editor.innerText()).includes(title)&&(await editor.innerText()).includes(marker));
 await capture('文件名内容重载后仍持久化');remaining.delete('标题同步文件名及重载持久化');
}

async function progressSnapshot(page){
 return page.locator('aside.mw-knowledge-workspace [role="tabpanel"] div[class~="h-[60px]"]').filter({visible:true}).evaluateAll(nodes=>{
  if(nodes.length!==1)return {visible:false};
  const node=nodes[0],message=node.querySelector('span[title]'),counter=node.firstElementChild?.lastElementChild?.textContent||'',counts=counter.match(/(\d+)\s*\/\s*(\d+)/),bar=node.querySelector('div[class~="h-[6px]"] > div');
  return {visible:true,text:node.textContent,message:message?.getAttribute('title'),completed:counts?Number(counts[1]):null,total:counts?Number(counts[2]):null,percent:bar?parseFloat(bar.style.width):null,animationName:message?getComputedStyle(message).animationName:null};
 });
}

async function parseFormats(context,call,created){
 const {page,number,dir,resources,assert,capture,remaining}=context;
 const inputs=await prepareKnowledgeFormats(created.source_dir[0]);await save(dir,'多格式合成源清单.json',inputs);
 await openSources(page,created,context);await refreshSources(page,call,created);await observeKnowledgeSourceRows(page,flattenKnowledgeFiles(await call('/knowledge/'+created.id+'/source',{})));
 await capture('全量解析八份真实格式源文件');remaining.delete('八份真实格式独立源材料');
 const samples=[],capturedStages=new Set();
 const parsed=await parseOwnedKnowledge({...context,call,created,owned:resources.knowledgeCreation,timeoutMs:540000,onProgress:number===131?async progress=>{
  const ui=await progressSnapshot(page),sample={at:Date.now(),progress,ui};samples.push(sample);await save(dir,'实际解析进度与界面观察.json',samples);
  if(ui.visible&&!capturedStages.has(progress.stage)){capturedStages.add(progress.stage);await capture('真实解析进度阶段-'+progress.stage);}
 }:undefined});
 remaining.delete('真实全量解析及本轮终态');
 const files=flattenKnowledgeFiles(await call('/knowledge/'+created.id+'/source',{}));await save(dir,'多格式解析终态源状态.json',files);
 const failures=inputs.map(input=>({name:input.name,status:files.find(file=>sameKnowledgePath(file.path,input.path))?.status})).filter(item=>item.status!=='success');
 assert('每一种原表格式源文件实际解析成功',failures.length===0,failures);
 const facts=[];
 for(const input of inputs){
  const raw=path.join(created.wiki_dir,'raw',rawKnowledgeName(input.path)),text=await fs.readFile(raw,'utf8');
  const missing=input.facts.filter(fact=>!normalizedKnowledgeText(text).includes(normalizedKnowledgeText(fact)));
  facts.push({name:input.name,raw,characters:text.length,missing});
  assert('各源文件真实raw保留核心事实：'+input.name,missing.length===0,{raw,missing});
 }
 await save(dir,'各格式实际解析正文事实.json',facts);remaining.delete('各格式实际状态与解析正文事实');
 const wiki=parsed.files.filter(item=>sameKnowledgePath(path.dirname(item.path),path.join(created.wiki_dir,'wiki','sources')));
 assert('实际生成本轮Wiki资料页',wiki.length>0);
 const missingSources=inputs.filter(input=>!wiki.some(item=>item.text.includes(rawKnowledgeName(input.path))));
 await save(dir,'真实Wiki来源覆盖.json',{pages:wiki.map(item=>item.path),missing:missingSources.map(item=>item.name)});
 assert('Wiki实际来源覆盖本轮所有格式源文件',missingSources.length===0,missingSources.map(item=>item.name));
 const cards=await call('/knowledge/'+created.id+'/cards');await save(dir,'实际生成知识卡片清单.json',cards);
 assert('本轮实际生成可读取知识卡片',cards.length>0);
 const first=cards[0],detail=await call('/knowledge/'+created.id+'/cards/'+encodeURIComponent(first.id));
 await save(dir,'本轮实际知识卡片详情.json',detail);
 assert('卡片实际内容与来源均存在',!!detail.content.trim()&&detail.related_wikis.length>0);
 await page.getByRole('tab',{name:'知识卡片',exact:true}).click();
 const card=page.locator('aside.mw-knowledge-workspace').getByRole('button').filter({has:page.getByText(first.title,{exact:true})});await card.waitFor();await card.click();
 await page.getByRole('heading',{name:first.title,exact:true}).waitFor();await capture('全量解析生成知识卡片实际展示');remaining.delete('真实Wiki来源及知识卡片');
 assert('全量解析未修改原始各格式源字节',(await Promise.all(inputs.map(async item=>fingerprint(await fs.readFile(item.path))===item.sha256))).every(Boolean));
 if(number===131){
  const assessment=assessKnowledgeProgress(samples);await save(dir,'进度与时长分支实际覆盖.json',assessment);
  assert('观察到的进度计数和百分比在有效范围',assessment.invalid.length===0,assessment.invalid);
  if(assessment.matched>0)remaining.delete('真实UI进度计数与动作一致');
  if(assessment.stages.length>=2&&assessment.messages.length>=2)remaining.delete('真实不同阶段与文案变化');
  if(assessment.animated)remaining.delete('实际动作文本动态效果');
  if(assessment.medium&&assessment.long)remaining.delete('中长等待实际文案分支');
  if(assessment.missing.length||!assessment.animated)throw review('解析产物已验证，进度专项现场仍缺：'+[...assessment.missing,...(!assessment.animated?['动作文本动态效果']:[])].join('、')+'；不延迟或篡改服务制造耗时分支');
 }
}

export async function runKnowledgeIngestSteps(context,{call,created}){
 if(context.number===127)return searchNames(context,call,created);
 if(context.number===128)return importFolder(context,call,created);
 if(context.number===129)return createAndEdit(context,call,created);
 return parseFormats(context,call,created);
}
