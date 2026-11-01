import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {selectNativeFolder} from './mobilework-native-folder.mjs';
import {sameKnowledgePath} from './mobilework-knowledge-resources.mjs';
import {closeKnowledgeSettings,openKnowledgeSettings} from './mobilework-knowledge-api.mjs';
import {openSources,refreshSources} from './client-knowledge-source-steps.mjs';
import {prepareKnowledgeReading,knowledgeFingerprint} from './mobilework-knowledge-reading.mjs';
import {parseOwnedKnowledge} from './mobilework-knowledge-parse.mjs';
import {flattenKnowledgeFiles,hasKnowledgeBudget} from './mobilework-knowledge-source-ui.mjs';
import {knowledgeDirectoryManifest} from './mobilework-knowledge-graph-settings.mjs';
import {sameSourceDirectories,stableParseModelMenu} from './mobilework-knowledge-settings.mjs';

const button=(scope,name)=>scope.getByRole('button',{name,exact:true}).filter({visible:true});
const settingsOf=page=>page.getByRole('dialog',{name:'设置',exact:true}).filter({visible:true});
const sourceSection=page=>settingsOf(page).locator('section').filter({has:page.getByText('源文件目录',{exact:true})});
const save=(context,name,value)=>fs.writeFile(path.join(context.dir,name+'.json'),JSON.stringify(value,null,2));
const review=message=>Object.assign(Error(message),{review:true});

async function settings(context,created,options){
 await openSources(context.page,created,context,options);return openKnowledgeSettings(context.page,context);
}
async function protect(context,fixture){
 context.assert('设置操作保留本轮外部源文件字节',(await Promise.all(fixture.inputs.map(async item=>knowledgeFingerprint(await fs.readFile(item.path))===item.sha256))).every(Boolean));
}
async function addSource(context,call,created){
 const folder=path.join(context.dir,'本轮外部引用源');await fs.mkdir(folder);
 const fixture=await prepareKnowledgeReading({source_dir:[folder]});await save(context,'外部源文件及隐藏事实',fixture);
 await settings(context,created);
 const [responseResult,selectionResult]=await Promise.allSettled([
  context.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/knowledge/add_source'&&response.request().postDataJSON().id===created.id,{timeout:60000}),
  selectNativeFolder(context.page,{folder,dir:context.dir,control:context.control,log:context.log,open:()=>button(sourceSection(context.page),'添加').click()})
 ]);
 if(selectionResult.status==='rejected')throw selectionResult.reason;
 if(responseResult.status==='rejected')throw responseResult.reason;
 const response=responseResult.value,body=await response.json();
 await save(context,'源路径真实添加请求',{request:response.request().postDataJSON(),httpStatus:response.status(),success:body.success});
 context.assert('原生目录确认后真实添加指定源路径',response.ok()&&body.success==='true'&&sameKnowledgePath(response.request().postDataJSON().source_dir,folder));
 await context.page.waitForFunction(folder=>[...document.querySelectorAll('[role="dialog"][aria-label="设置"] span')].some(node=>node.textContent===folder),folder);
 const current=await call('/knowledge/'+created.id);
 context.assert('只追加本轮源路径且保留全部原引用',sameSourceDirectories(current.source_dir,[...created.source_dir,folder]));
 await context.capture('原生源目录添加及真实回显');await closeKnowledgeSettings(context.page,{storageDir:created.storage_dir});
 await settings(context,created,{reload:true});
 context.assert('重新加载后本轮源引用保留',(await sourceSection(context.page).innerText()).includes(folder)&&sameSourceDirectories((await call('/knowledge/'+created.id)).source_dir,[...created.source_dir,folder]));
 await closeKnowledgeSettings(context.page,{storageDir:created.storage_dir});
 await openSources(context.page,created,context);const files=await refreshSources(context.page,call,created);
 context.assert('添加目录中的每份真实源进入解析列表',fixture.inputs.every(input=>files.some(file=>sameKnowledgePath(file.path,input.path))));
 await protect(context,fixture);context.remaining.delete('原生源目录添加回读及重载持久');
 return {folder,fixture};
}
async function parseAdded(context,call,created,fixture){
 await parseOwnedKnowledge({...context,call,created,owned:context.resources.knowledgeCreation,timeoutMs:540000});
 const files=flattenKnowledgeFiles(await call('/knowledge/'+created.id+'/source',{}));
 context.assert('新增引用源实际解析成功',fixture.inputs.every(input=>files.some(file=>sameKnowledgePath(file.path,input.path)&&file.status==='success')));
 const pages=(await knowledgeDirectoryManifest(path.join(created.wiki_dir,'wiki'))).filter(file=>file.type==='file'&&file.path.endsWith('.md'));let wikiText='';
 for(const file of pages)wikiText+=await fs.readFile(path.join(created.wiki_dir,'wiki',file.path),'utf8');
 context.assert('新增源实际生成Wiki并保留合成事实',wikiText.includes(fixture.code)&&hasKnowledgeBudget(wikiText,fixture.budget));
 await save(context,'新增源实际解析状态',{files,wikiPages:pages});await protect(context,fixture);
 await context.capture('新增引用源真实解析完成');context.remaining.delete('新增源真实解析终态及Wiki事实');
}
async function removeSource(context,call,created,{folder,fixture}){
 await settings(context,created);
 const row=sourceSection(context.page).locator('div').filter({has:context.page.locator('span').filter({hasText:folder})}).filter({has:button(context.page,'移除')}).last();
 const openConfirm=async()=>{
  await button(row,'移除').click();const dialog=context.page.getByRole('alertdialog',{name:'你确定移除文件夹吗？',exact:true}).filter({visible:true});await dialog.waitFor();
  context.resources.knowledgeCreation.dialogToken=randomUUID();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-knowledge-owner',token),context.resources.knowledgeCreation.dialogToken);await context.checkpointResources();
  context.assert('移除前真实二次确认说明源文件退出知识库',(await dialog.innerText()).includes('移除后文件夹内源文件也将从知识库内移除'));return dialog;
 };
 let dialog=await openConfirm();await context.capture('本轮源路径移除二次确认');await button(dialog,'取消').click();await dialog.waitFor({state:'hidden'});delete context.resources.knowledgeCreation.dialogToken;await context.checkpointResources();
 context.assert('取消移除保留本轮及原有源路径',sameSourceDirectories((await call('/knowledge/'+created.id)).source_dir,[...created.source_dir,folder]));await protect(context,fixture);context.remaining.delete('移除二次确认取消保留');
 dialog=await openConfirm();const [response]=await Promise.all([context.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/knowledge/remove_source'&&response.request().postDataJSON().id===created.id),button(dialog,'确定移除').click()]);
 const body=await response.json();await save(context,'源路径真实移除请求',{request:response.request().postDataJSON(),httpStatus:response.status(),success:body.success});
 context.assert('真实确认仅移除指定引用路径',response.ok()&&body.success==='true'&&sameKnowledgePath(response.request().postDataJSON().source_dir,folder));
 await dialog.waitFor({state:'hidden'});delete context.resources.knowledgeCreation.dialogToken;await context.checkpointResources();
 await context.page.waitForFunction(folder=>![...document.querySelectorAll('[role="dialog"][aria-label="设置"] span')].some(node=>node.textContent===folder),folder);
 await closeKnowledgeSettings(context.page,{storageDir:created.storage_dir});await openSources(context.page,created,context);
 const files=await refreshSources(context.page,call,created);
 context.assert('移除后源列表无本轮文件且原引用完整保留',sameSourceDirectories((await call('/knowledge/'+created.id)).source_dir,created.source_dir)&&fixture.inputs.every(input=>files.every(file=>!sameKnowledgePath(file.path,input.path))));
 await settings(context,created,{reload:true});context.assert('重载后移除结果保留',!(await sourceSection(context.page).innerText()).includes(folder)&&sameSourceDirectories((await call('/knowledge/'+created.id)).source_dir,created.source_dir));await closeKnowledgeSettings(context.page,{storageDir:created.storage_dir});
 await protect(context,fixture);await context.capture('源引用移除而本地文件保留');context.remaining.delete('确认移除持久源列表及本地文件保护');
}
async function configureModels(context,call,created){
 const popup=context.page.locator('[data-slot="popover-content"]').filter({visible:true}).filter({has:context.page.locator('input[placeholder*="搜索模型"]')});
 const open=async()=>{
  await button(settingsOf(context.page),'切换模型').click();await popup.waitFor();
  context.resources.knowledgeCreation.modelMenuToken=randomUUID();await popup.evaluate((node,token)=>node.setAttribute('data-mw-parse-model-owner',token),context.resources.knowledgeCreation.modelMenuToken);await context.checkpointResources();
  return stableParseModelMenu(context.page,popup);
 };
 const close=async()=>{await popup.press('Escape');await popup.waitFor({state:'hidden'});delete context.resources.knowledgeCreation.modelMenuToken;await context.checkpointResources();};
 await settings(context,created);let snapshot=await open();let models;
 try{models=await snapshot.evaluate(value=>value.models);}finally{await snapshot.dispose();}
 await save(context,'完整稳定解析模型候选',models);
 const modelLabel=()=>button(settingsOf(context.page),'切换模型').locator('span.truncate').innerText();
 const current=(await call('/knowledge/'+created.id)).model_id,shown=(await modelLabel()).trim(),initial=models.find(model=>model.id===current);
 await save(context,'初始解析模型实际身份与名称',{modelId:current,shown});
 context.assert('当前解析模型展示对应已保存身份',shown===current||shown===initial?.title);await context.capture('解析模型完整稳定列表');await close();context.remaining.delete('当前解析模型及完整稳定候选');
 const chosen=[models.find(model=>!model.custom&&model.id!==current)||models.find(model=>!model.custom),models.find(model=>model.custom&&model.id!==current)||models.find(model=>model.custom)].filter(Boolean).sort((a,b)=>Number(a.id===current)-Number(b.id===current)),observations=[];
 for(const model of chosen){
  if((await call('/knowledge/'+created.id)).model_id===model.id)continue;
  snapshot=await open();let element;
  try{
   element=await snapshot.evaluateHandle((value,id)=>value.elements[value.models.findIndex(model=>model.id===id)],model.id);
   if(!await element.evaluate(node=>!!node?.isConnected))throw review('解析模型刷新后目标元素已脱离，未按旧位置点击');
   const [response]=await Promise.all([context.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/knowledge/update_config'&&response.request().postDataJSON().id===created.id),element.asElement().click()]);
   const body=await response.json();context.assert('解析模型切换真实保存：'+model.title,response.ok()&&body.success==='true'&&response.request().postDataJSON().configs.model_id===model.id);
   observations.push({model,httpStatus:response.status(),success:body.success});await save(context,'解析模型真实保存与重载',observations);
  }finally{if(element)await element.dispose();await snapshot.dispose();}
  await popup.waitFor({state:'hidden'});delete context.resources.knowledgeCreation.modelMenuToken;await context.checkpointResources();
  await closeKnowledgeSettings(context.page,{storageDir:created.storage_dir});await settings(context,created,{reload:true});
  const persisted={modelId:(await call('/knowledge/'+created.id)).model_id,shown:(await modelLabel()).trim()};
  observations.at(-1).persisted=persisted;await save(context,'解析模型真实保存与重载',observations);
  context.assert('解析模型身份及界面在重载后保留：'+model.title,persisted.modelId===model.id&&[model.title,model.id].includes(persisted.shown),persisted);await context.capture('解析模型保存-'+(model.custom?'个人':'官方'));
 }
 await closeKnowledgeSettings(context.page,{storageDir:created.storage_dir});
 if(chosen.length!==2)throw review('当前真实列表缺可切换的官方或个人模型；已验证可用分支，不新增凭据或把缺模型当通过');
 context.remaining.delete('官方个人解析模型切换保存及重载');
}
export async function runKnowledgeSettingsSteps(context,{call,created}){
 if(context.number===144)return configureModels(context,call,created);
 const added=await addSource(context,call,created);
 if(context.number===142)await parseAdded(context,call,created,added.fixture);
 else await removeSource(context,call,created,added);
}
