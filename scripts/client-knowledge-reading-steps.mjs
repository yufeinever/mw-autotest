import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {observeOwnedKnowledgePreview,dismissOwnedKnowledgePreview} from './mobilework-knowledge-preview.mjs';
import path from 'node:path';
import {parseOwnedKnowledge} from './mobilework-knowledge-parse.mjs';
import {openSources,refreshSources} from './client-knowledge-source-steps.mjs';
import {flattenKnowledgeFiles,observeKnowledgeSourceRows} from './mobilework-knowledge-source-ui.mjs';
import {sameKnowledgePath} from './mobilework-knowledge-resources.mjs';
import {rawKnowledgeName} from './mobilework-knowledge-ingest.mjs';
import {prepareKnowledgeReading,assessSingleKnowledge,assessWikiDocument,assessKnowledgeCard,flattenWikiNodes,knowledgeFingerprint,knowledgeMultiset,readableKnowledgeText} from './mobilework-knowledge-reading.mjs';

const review=message=>Object.assign(Error(message),{review:true});
const blocked=message=>Object.assign(Error(message),{blocked:true});
const save=(dir,name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2));
const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const sourceRow=(page,name)=>page.locator('[data-knowledge-source-node][role="button"]').filter({has:page.locator('span[title='+JSON.stringify(name)+']')});
const exactText=value=>new RegExp('^'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$');

async function prepare(context,call,created){
 const fixture=await prepareKnowledgeReading(created,{single:context.number===132});
 await save(context.dir,'本轮知识阅读源事实.json',fixture);
 await openSources(context.page,created,context);const files=await refreshSources(context.page,call,created);
 await observeKnowledgeSourceRows(context.page,files);await context.capture('独立知识阅读源材料');
 context.remaining.delete('独立真实源材料与解析前状态');return fixture;
}

async function singleDocument(context,call,created,fixture){
 const {page,dir,resources,assert,capture,remaining}=context,[target,control]=fixture.inputs;
 const before=flattenKnowledgeFiles(await call('/knowledge/'+created.id+'/source',{}));
 await save(dir,'单文档解析前状态.json',before);
 assert('目标与对照源文件都真实存在且尚未解析',[target,control].every(input=>before.some(file=>sameKnowledgePath(file.path,input.path)&&file.status==='unparsed')));
 const requests=[],watch=request=>{
  if(request.method()!=='POST')return;const route=new URL(request.url()).pathname;
  if(!['/knowledge/parse_source','/knowledge/full_update'].includes(route))return;
  const body=request.postDataJSON();if(body.id===created.id)requests.push({route,source_file:body.source_file});
 };
 page.on('request',watch);let parsed;
 try{
  parsed=await parseOwnedKnowledge({...context,call,created,owned:resources.knowledgeCreation,timeoutMs:540000,startParsing:async()=>{
   const row=sourceRow(page,target.name);await row.hover();const parse=row.locator('button:not([title="删除"])').filter({visible:true});
   if(await parse.count()!==1)throw blocked('未唯一识别本轮目标源文件解析控件');
   await parse.hover();await page.locator('[data-slot="tooltip-content"][data-open]:not([data-closed])').filter({hasText:'更新'}).filter({visible:true}).waitFor();
   await capture('单个目标文件真实解析控件');
   const [response]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/knowledge/parse_source'&&r.request().postDataJSON().id===created.id&&r.request().postDataJSON().source_file===target.path,{timeout:540000}),parse.click()]);
   const body=await response.json();await save(dir,'真实单文档解析请求结果.json',{request:response.request().postDataJSON(),httpStatus:response.status(),response:body});
   assert('真实单文档解析请求及目标文件终态成功',response.ok()&&body.success==='true'&&body.data.status==='success');
  }});
 }finally{page.off('request',watch);await save(dir,'本轮实际解析请求范围.json',requests);}
 remaining.delete('真实目标源行单文档解析及终态');
 const files=flattenKnowledgeFiles(await call('/knowledge/'+created.id+'/source',{})),raw=path.join(created.wiki_dir,'raw',rawKnowledgeName(target.path)),text=await fs.readFile(raw,'utf8');
 const controlRaw=path.join(created.wiki_dir,'raw',rawKnowledgeName(control.path));let controlRawExists;
 try{await fs.access(controlRaw);controlRawExists=true;}catch(error){if(error.code!=='ENOENT')throw error;controlRawExists=false;}
 const result=assessSingleKnowledge({target,control,files,requests,targetText:text,controlRawExists,facts:[fixture.code,fixture.budget,fixture.owner,'权限功能待复核']});
 await save(dir,'单文档解析范围及真实产物.json',{result,files,raw,controlRaw});
 assert('单文档只请求目标且未触发全量解析',result.targetedRequest,requests);
 assert('目标实际解析成功且raw正文保留核心事实',result.targetSuccess&&result.missingFacts.length===0,result);
 assert('对照文档仍未解析且未生成raw',result.controlUnparsed&&result.controlRawAbsent,result);remaining.delete('目标真实产物及对照未解析');
 assert('单文档解析生成真实Wiki来源页',parsed.files.some(file=>sameKnowledgePath(path.dirname(file.path),path.join(created.wiki_dir,'wiki','sources'))&&file.text.includes(rawKnowledgeName(target.path))));
 await openSources(page,created,context);await observeKnowledgeSourceRows(page,files);await capture('单文档成功与对照未解析');
}

async function readWikiEditor(context,source){
 const {page}=context,editor=page.locator('.mw-wiki-editor .cm-content[contenteditable="true"]').filter({visible:true});await editor.waitFor();
 // The installed app exports its actual CodeMirror EditorView as E. Use its
 // public findFromDOM API to read this editor's entire document, not a virtualized DOM fragment.
 const observed=await editor.evaluate(async node=>{
  const modules=[...document.querySelectorAll('script[type="module"][src]')].filter(script=>/\/assets\/app-[^/]+\.js$/.test(new URL(script.src).pathname));
  if(modules.length!==1)return {supported:false,reason:'无法唯一识别当前客户端主模块'};
  const {E:EditorView}=await import(modules[0].src);
  if(typeof EditorView?.findFromDOM!=='function')return {supported:false,reason:'当前主模块未提供已识别的EditorView接口'};
  const view=EditorView.findFromDOM(node);
  if(!view||view.contentDOM!==node)return {supported:false,reason:'当前可见编辑器未对应真实EditorView'};
  return {supported:true,documentText:view.state.doc.toString(),moduleUrl:modules[0].src};
 });
 if(!observed.supported)throw review(observed.reason+'；完整正文未验证');
 const documentText=observed.documentText;
 const scroller=page.locator('.mw-wiki-editor .cm-scroller').filter({visible:true});
 const top=await editor.innerText();await scroller.evaluate(node=>{node.scrollTop=node.scrollHeight;});
 // Wait for CodeMirror to draw the requested viewport; the actual editor document is already recorded in full.
 await page.waitForFunction(()=>{const node=document.querySelector('.mw-wiki-editor .cm-scroller');return node&&node.scrollTop+node.clientHeight>=node.scrollHeight-2;});
 const bottom=await editor.innerText(),left=await page.locator('aside.mw-knowledge-workspace').boundingBox(),right=await editor.boundingBox();
 return {source,documentText,top,bottom,moduleUrl:observed.moduleUrl,...assessWikiDocument({source,documentText,left,right})};
}

async function wikiList(context,call,created){
 const {page,dir,assert,capture,remaining}=context,tree=await call('/knowledge/'+created.id+'/wiki',{}),nodes=flattenWikiNodes(tree),files=nodes.filter(node=>node.type==='file');
 await save(dir,'真实Wiki完整目录树.json',tree);assert('真实解析后Wiki目录和文件均存在',nodes.some(node=>node.type==='directory')&&files.length>0);
 await page.getByRole('tab',{name:'Wiki',exact:true}).click();
 const panel=page.locator('aside.mw-knowledge-workspace [role="tabpanel"]').filter({visible:true});
 const list=panel.locator('div.scrollbar-hover'),rows=new Map();
 async function expand(children,scope){
  for(const node of children){
   const row=scope.locator(node.type==='directory'?':scope > div > button':':scope > button').filter({hasText:exactText(node.name)});
   await row.waitFor();rows.set(node.path,row);
   if(node.type==='directory'){
    if(await row.locator('svg.lucide-chevron-right').count())await row.click();
    await expand(node.children||[],row.locator('xpath=..'));
   }
  }
 }
 await expand(tree,list);
 const shown=await list.locator('button span.truncate').allTextContents();
 await save(dir,'Wiki左侧实际完整列表.json',shown);
 assert('Wiki全部文件夹与文件按完整多重集合展示',knowledgeMultiset(shown)===knowledgeMultiset(nodes.map(node=>node.name)),{expected:nodes.map(node=>node.name),shown});
 await capture('Wiki全部目录及文件');remaining.delete('Wiki完整文件夹文件及左右布局');
 const observations=[];
 for(const file of files){
  await rows.get(file.path).click();const source=(await call('/knowledge/'+created.id+'/wiki/file?path='+encodeURIComponent(file.path))).content;
  await page.getByRole('heading',{name:path.parse(file.name).name,exact:true}).waitFor();
  const observation=await readWikiEditor(context,source);observations.push({path:file.path,...observation});
  await save(dir,'Wiki逐文件完整正文与布局.json',observations);
  assert('完整正文与实际文件一致：'+file.name,observation.complete,{sourceCharacters:source.length,documentCharacters:observation.documentCharacters});
  assert('Wiki列表与正文保持左右布局：'+file.name,observation.sideBySide);
  await capture('Wiki实际完整正文-'+file.name);
 }
 remaining.delete('逐文档完整正文及结构展示');
}

const cardRows=page=>page.locator('aside.mw-knowledge-workspace button').filter({has:page.locator('span.font-semibold')});
const cardRow=(context,item)=>cardRows(context.page).nth(context.knowledgeCardItems.findIndex(card=>card.id===item.id));
const relationSection=(page,title)=>page.locator('section').filter({has:page.getByRole('heading',{name:title,exact:true})}).filter({visible:true});
async function cardObservation(page,detail){
 const heading=page.getByRole('heading',{name:detail.title,exact:true});await heading.waitFor();const body=heading.locator('xpath=..');
 await page.waitForFunction(({title,date,summary})=>[...document.querySelectorAll('h2')].some(node=>node.textContent===title&&node.parentElement.textContent.includes(date)&&node.parentElement.textContent.replace(/[#*_`|>\s]/g,'').includes(summary)),{title:detail.title,date:detail.updated_at,summary:readableKnowledgeText(detail.summary)});
 const contentArea=await body.locator('div.max-h-11').evaluate(node=>{
  const style=getComputedStyle(node),rect=node.getBoundingClientRect();
  return {text:node.innerText,width:rect.width,height:rect.height,clientWidth:node.clientWidth,clientHeight:node.clientHeight,scrollWidth:node.scrollWidth,scrollHeight:node.scrollHeight,overflowX:style.overflowX,overflowY:style.overflowY};
 });
 return {title:await heading.innerText(),body:await body.innerText(),contentArea,tags:await body.locator('span.text-primary').allTextContents(),
  relatedCards:await relationSection(page,'关联知识卡片').getByRole('button').allTextContents(),relatedWikis:await relationSection(page,'关联wiki').getByRole('button').allTextContents()};
}
async function openCard(context,call,created,item){
 const row=cardRow(context,item);
 await row.scrollIntoViewIfNeeded();await row.click();
 context.assert('卡片实际选中状态对应本轮ID：'+item.id,(await row.getAttribute('class')).includes('--mw-knowledge-card-active-bg'));
 const detail=await call('/knowledge/'+created.id+'/cards/'+encodeURIComponent(item.id)),observed=await cardObservation(context.page,detail);
 context.assert('读取的知识卡片详情ID与选中行一致',detail.id===item.id);
 return {detail,observed,assessment:assessKnowledgeCard(detail,observed)};
}

async function relatedNavigation(context,call,created,origin){
 const {page,dir,assert,capture,resources,checkpointResources}=context,records=[];
 // Return to the actual origin card between links; a destination's relationships cannot stand in for the origin's list.
 for(const item of origin.related_cards){
  await openCard(context,call,created,origin);
  const link=button(relationSection(page,'关联知识卡片'),item.title);
  if(await link.count()!==1)throw review('关联卡片显示同名，无法从本轮UI唯一确定目标：'+item.title);
  const targetIndex=context.knowledgeCardItems.findIndex(card=>card.id===item.id);
  if(targetIndex<0)throw review('关联目标ID不在本轮已核对侧栏列表，未用API自证界面归属：'+item.id);
  await link.click();
  const destination=cardRows(page).nth(targetIndex).and(page.locator('button[class*="--mw-knowledge-card-active-bg"]'));
  await destination.waitFor();
  const detail=await call('/knowledge/'+created.id+'/cards/'+encodeURIComponent(item.id)),observed=await cardObservation(page,detail);
  const selected={id:item.id,index:targetIndex,className:await destination.getAttribute('class')};
  const assessment=assessKnowledgeCard(detail,observed);records.push({kind:'card',id:item.id,selected,detail,observed,assessment});await save(dir,'实际关联逐项跳转.json',records);
  assert('关联卡片打开对应ID的真实详情：'+item.title,detail.id===item.id&&selected.className.includes('--mw-knowledge-card-active-bg')&&assessment.title&&assessment.date&&assessment.summary&&assessment.tags);
  await capture('真实关联卡片-'+item.title);
 }
 for(const item of context.number===135?origin.related_wikis:[]){
  await openCard(context,call,created,origin);
  if(await page.getByRole('dialog').filter({visible:true}).count())throw blocked('打开关联Wiki前已有未知弹框，保留现场');
  const detail=await call('/knowledge/'+created.id+'/wiki/'+encodeURIComponent(item.id));
  const link=button(relationSection(page,'关联wiki'),item.title);
  if(await link.count()!==1)throw review('关联Wiki显示同名，无法唯一确定目标：'+item.title);
  const owned=resources.knowledgeCreation,preview={previewWikiId:item.id,previewToken:randomUUID(),previewTitle:detail.title};
  if((await observeOwnedKnowledgePreview(page,{...owned,...preview})).status!=='closed')throw blocked('关联Wiki点击前本轮库预览尚未关闭，保留现场');
  Object.assign(owned,preview);await checkpointResources();
  await link.click();await observeOwnedKnowledgePreview(page,owned,{waitFor:'open',tag:true});
  const dialog=page.locator('[data-mw-knowledge-preview-owner="'+owned.previewToken+'"]');
  await dialog.getByRole('heading',{name:detail.title,exact:true}).waitFor();
  await observeOwnedKnowledgePreview(page,owned,{waitFor:'open',tag:true});
  const text=await dialog.innerText(),complete=readableKnowledgeText(text).includes(readableKnowledgeText(detail.content));
  records.push({kind:'wiki',id:item.id,detail,text,complete});await save(dir,'实际关联逐项跳转.json',records);
  assert('关联Wiki实际完整正文与来源ID一致：'+item.title,detail.id===item.id&&detail.content.trim().length>0&&complete);
  await capture('真实关联Wiki-'+item.title);await dismissOwnedKnowledgePreview(page,owned);await checkpointResources();
 }
}

async function cards(context,call,created){
 const {page,number,dir,assert,capture,remaining}=context,items=await call('/knowledge/'+created.id+'/cards');
 await save(dir,'本轮真实卡片全集.json',items);assert('实际解析产生知识卡片',items.length>0);
 context.knowledgeCardItems=items;
 await page.getByRole('tab',{name:'知识卡片',exact:true}).click();await cardRow(context,items[0]).waitFor();
 const rows=cardRows(page);
 const shown=await rows.locator('span.font-semibold').allTextContents();await save(dir,'实际知识卡片列表.json',shown);
 assert('知识卡片全部列表与实际登记一致',knowledgeMultiset(shown)===knowledgeMultiset(items.map(item=>item.title)));
 assert('卡片UI行顺序与实际ID列表对应',JSON.stringify(shown)===JSON.stringify(items.map(item=>item.title)));
 const details=[];
 for(const item of items){
  const row=cardRow(context,item);await row.scrollIntoViewIfNeeded();const text=await row.innerText();
  assert('卡片列表标题摘要时间和标签真实展示：'+item.title,text.includes(item.title)&&readableKnowledgeText(text).includes(readableKnowledgeText(item.summary))&&text.includes(item.updated_at)&&item.tags.every(tag=>text.includes(tag==='concept'?'概念':'实体')));
  const observation=await openCard(context,call,created,item);details.push(observation);await save(dir,'知识卡片全部详情观察.json',details);
  assert('卡片详情标题时间标签及摘要一致：'+item.title,['title','date','tags','summary'].every(key=>observation.assessment[key]),observation.assessment);
  assert('关联列表与当前卡片真实关系一致：'+item.title,observation.assessment.relatedCards&&observation.assessment.relatedWikis,observation.assessment);
  await capture('真实知识卡片详情-'+item.title);
 }
 remaining.delete('全部卡片列表及真实元数据');remaining.delete('当前卡片真实关联完整列表');
 const origin=details.find(item=>item.detail.related_cards.length>0&&(number===134||item.detail.related_wikis.length>0));
 if(!origin)throw review('本轮实际解析未生成所需关联边，保留关联点击目标；不编造知识卡片或来源关系');
 await relatedNavigation(context,call,created,origin.detail);remaining.delete('关联卡片真实详情跳转');if(number===135)remaining.delete('关联Wiki真实来源正文预览');
 if(number===134){
  const incomplete=details.filter(item=>!item.assessment.fullContent).map(item=>item.detail.id);
  if(incomplete.length)throw review('当前详情未完整可读（仅摘要或正文被裁切），原表卡片内容语义仍待复核，未降低为API正文存在通过；待复核ID：'+incomplete.join('、'));
  remaining.delete('卡片内容完整性与原表语义');
 }
}

async function emptyGraph(context,call,created){
 const {page,dir,assert,capture,remaining}=context;
 const inspect=async label=>{
  const graph=await call('/knowledge/'+created.id+'/graph'),cards=await call('/knowledge/'+created.id+'/cards'),files=flattenKnowledgeFiles(await call('/knowledge/'+created.id+'/source',{})),progress=await call('/knowledge/'+created.id+'/progress');
  await save(dir,label+'真实空库数据.json',{graph,cards,files,progress});
  assert('未解析新库没有实体概念关系及源文件',graph.nodes.length===0&&graph.edges.length===0&&cards.length===0&&files.length===0&&!progress.isActive);
  await page.getByRole('tab',{name:'知识图谱',exact:true}).click();
  const text=page.getByText('解析源文件后，展示相关图谱',{exact:true}).filter({visible:true});await text.waitFor();
  const area=text.locator('xpath=../..');
  assert('图谱空态文案与插图真实可见',await text.isVisible()&&await area.locator('img').isVisible());
  assert('空态不是加载中或错误重试',await button(area,'重试').count()===0&&!/加载|失败|错误/.test(await area.innerText()));
  await capture(label+'真实知识图谱空态');
 };
 await openSources(page,created,context);await inspect('初次');remaining.delete('无实体概念及真实图谱空态');
 await openSources(page,created,context,{reload:true});await inspect('重载后');remaining.delete('重载空态持久且非错误状态');
}

export async function runKnowledgeReadingSteps(context,{call,created}){
 if(context.number===136)return emptyGraph(context,call,created);
 const fixture=await prepare(context,call,created);
 if(context.number===132)await singleDocument(context,call,created,fixture);
 else{
  await parseOwnedKnowledge({...context,call,created,owned:context.resources.knowledgeCreation,timeoutMs:540000});context.remaining.delete('真实解析生成Wiki及卡片');
 }
 context.assert('知识阅读及解析未改写原始测试源字节',(await Promise.all(fixture.inputs.map(async input=>knowledgeFingerprint(await fs.readFile(input.path))===input.sha256))).every(Boolean));
 if(context.number===132)context.remaining.delete('单文档真实来源及原材料保护');
 else if(context.number===133)await wikiList(context,call,created);else await cards(context,call,created);
}
