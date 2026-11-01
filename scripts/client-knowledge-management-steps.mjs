import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createManagedKnowledge} from './mobilework-knowledge-create.mjs';
import {runKnowledgeSourceSteps} from './client-knowledge-source-steps.mjs';
import {runKnowledgeIngestSteps} from './client-knowledge-ingest-steps.mjs';
import {runKnowledgeReadingSteps} from './client-knowledge-reading-steps.mjs';
import {runKnowledgeGraphSettingsSteps} from './client-knowledge-graph-settings-steps.mjs';
import {runKnowledgeSettingsSteps} from './client-knowledge-settings-steps.mjs';
import {sameKnowledgePath,releaseKnowledgeCreation} from './mobilework-knowledge-resources.mjs';
import {runKnowledgeListActions,runKnowledgeOnboardingObservation} from './client-knowledge-list-steps.mjs';
import {reloadOwnedModule,settleModuleReload} from './mobilework-module-navigation.mjs';
import {finishKnowledgeGuide} from './mobilework-knowledge-guide.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const review=message=>Object.assign(Error(message),{review:true});
const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
export const sourceTreeFiles=nodes=>nodes.flatMap(node=>node.type==='file'?[{name:node.name,path:node.path,status:node.status}]:sourceTreeFiles(node.children||[]));
const fingerprint=bytes=>createHash('sha256').update(bytes).digest('hex');

async function readListRows(context,items){
 const {page}=context;
 const snapshot=()=>page.evaluate(items=>{
  const dialogs=[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(n=>n.getClientRects().length);
  if(dialogs.some(n=>n.innerText.includes('配置已更新，需要重新加载引擎')))return {reloadPending:true};
  if(dialogs.length)return {unknownDialog:true};
  const buttons=[...document.querySelectorAll('aside button[aria-label]')];
  return {rows:items.map(item=>{
   const matches=buttons.filter(n=>n.getAttribute('aria-label')===item.name&&n.getClientRects().length);
   return {id:item.id,name:item.name,createdAt:item.created_at,updatedAt:item.updated_at,matches:matches.length,text:matches.length===1?matches[0].parentElement.parentElement.innerText:null};
  })};
 },items);
 let result=await snapshot();
 while(result.reloadPending){await settleModuleReload(context);result=await snapshot();}
 await fs.writeFile(path.join(context.dir,'知识库列表实际快照.json'),JSON.stringify(result,null,2));
 if(result.unknownDialog)throw blocked('知识库列表读取出现未知弹框，保留现场');
 if(result.rows.some(row=>row.matches!==1))throw review('知识库列表名称未唯一对应实际登记，未猜测列表行');
 return result.rows;
}

export async function runKnowledgeManagementSteps(context){
 const {number,page,resources,dir,remaining,assert,capture,checkpointResources,control,log}=context;
 const save=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2)),done=step=>remaining.delete(step);
 if(number===121){await runKnowledgeOnboardingObservation(context);return;}
 const {call,created,name,fixture,storageDir,outer,entry}=await createManagedKnowledge(context);
 if(number>=142){await runKnowledgeSettingsSteps(context,{call,created});return;}
 if(number>=137){await runKnowledgeGraphSettingsSteps(context,{call,created});return;}
 if(number>=132){await runKnowledgeReadingSteps(context,{call,created});return;}
 if(number>=127){await runKnowledgeIngestSteps(context,{call,created});return;}
 if(number>=122){await runKnowledgeSourceSteps(context,{call,created});return;}
 if(outer){
  await button(page,name).click();await finishKnowledgeGuide(page,page.getByRole('tab',{name:'源文件',exact:true}),{capture,log});
  const tree=await call('/knowledge/'+created.id+'/source',{}),files=sourceTreeFiles(tree);
  await save('五类原始知识来源实际树.json',files);
  assert('源文件树完整关联五类测试文件',files.length===5&&files.every(file=>Object.hasOwn(fixture.hashes,file.name)&&sameKnowledgePath(path.dirname(file.path),fixture.source)&&file.status!=='unable_parse'));
  const root=page.locator('[data-knowledge-source-node]').filter({has:page.locator('span[title="'+path.basename(fixture.source)+'"]')});
  await root.waitFor();
  if(!await page.getByText(files[0].name,{exact:true}).first().isVisible())await root.getByRole('button').first().click();
  for(const file of files)await page.getByText(file.name,{exact:true}).first().waitFor();
  const visibleFiles=await page.locator('[data-knowledge-source-node] span[title]').evaluateAll(nodes=>nodes.filter(node=>node.getBoundingClientRect().height&&/\.(docx|xlsx|pptx|pdf|md)$/i.test(node.title)).map(node=>node.title));
  assert('源文件UI完整展示五类文件及正确数量',JSON.stringify(visibleFiles.sort())===JSON.stringify(Object.keys(fixture.hashes).sort()),visibleFiles);
  assert('原始知识源内容未被创建操作更改',(await Promise.all(Object.entries(fixture.hashes).map(async([file,hash])=>fingerprint(await fs.readFile(path.join(fixture.source,file)))===hash))).every(Boolean));
  await capture('五类原始知识源真实列表');done('五类文件实际来源数量及内容保护');
 }else{
  await button(page,name).waitFor();await capture('默认知识库真实列表');
 }
 if(number>=117){await runKnowledgeListActions(context,{call,created});return;}
 if(number===116){
  await reloadOwnedModule(page,resources);await entry.waitFor();const current=await call('/knowledge/list'),rows=await readListRows(context,current);await save('知识库完整名称时间核对.json',rows);
  assert('列表每条名称与实际登记完整对应',rows.length===current.length&&rows.every(row=>row.text.includes(row.name)));
  const missing=rows.filter(row=>!row.text.includes(row.updatedAt));
  await button(page,name).click();await finishKnowledgeGuide(page,page.getByRole('tab',{name:'源文件',exact:true}),{capture,log});await capture('本轮专用知识库详情');done('独立知识库真实进入');
  assert('列表时间与实际更新时间一致',missing.length===0,missing);
  done('完整列表名称及更新时间');
  // Current shipped list renders createdAt. Equal fresh timestamps cannot
  // prove update semantics, so preserve the original requirement for review.
  throw review('当前版本列表源码渲染创建时间；本轮新库时间相等，仅核对快照，更新时间语义仍待复核');
 }
 await capture('知识库创建实际结果');
 await releaseKnowledgeCreation(page,resources);await checkpointResources();done('本轮注册公共收尾及材料保留');
}
