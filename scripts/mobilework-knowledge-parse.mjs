import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {knowledgeParserDiagnostic} from './mobilework-knowledge-api.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
export const completedKnowledgeParse=(progress,previous,observedActive)=>!progress.isActive&&progress.stage==='completed'&&(observedActive||progress.completedCount>0&&!previous.completedCount||!!progress.completionBatchId&&progress.completionBatchId!==previous.completionBatchId);

export async function parseOwnedKnowledge({page,call,created,dir,assert,capture,log,owned,checkpointResources,onProgress,startParsing,timeoutMs=150000}){
 const previous=await call('/knowledge/'+created.id+'/progress');
 if(startParsing)await startParsing();
 else{
 await page.locator('button[data-knowledge-guide="manage"]').filter({visible:true}).click();
 const dialog=page.getByRole('alertdialog').filter({visible:true});await dialog.waitFor();
 if(owned){
  owned.dialogToken=randomUUID();await dialog.evaluate((node,token)=>node.setAttribute('data-mw-knowledge-owner',token),owned.dialogToken);await checkpointResources();
 }
 const [response]=await Promise.all([
  page.waitForResponse(value=>value.request().method()==='POST'&&new URL(value.url()).pathname==='/knowledge/full_update'&&value.request().postDataJSON().id===created.id),
  dialog.getByRole('button',{name:'确定',exact:true}).click()
 ]);
 const body=await response.json();
 await fs.writeFile(path.join(dir,'真实全量解析请求.json'),JSON.stringify({id:created.id,httpStatus:response.status(),success:body.success},null,2));
 assert('全量解析请求已被真实服务接受',response.ok()&&body.success==='true');
 await dialog.waitFor({state:'hidden'});
 if(owned){delete owned.dialogToken;await checkpointResources();}
 }
 let observedActive=false,completed=false,progress;const timeline=[],deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  progress=await call('/knowledge/'+created.id+'/progress');observedActive||=progress.isActive===true;
  timeline.push({at:new Date().toISOString(),...progress});
  await fs.writeFile(path.join(dir,'知识库解析时间线.json'),JSON.stringify(timeline,null,2));
  await fs.writeFile(path.join(dir,'知识库解析进度.json'),JSON.stringify(progress,null,2));
  if(onProgress)await onProgress(progress);
  if(progress.pause)throw blocked('本轮知识库解析暂停，保留注册和材料，未放行下一条');
  if(completedKnowledgeParse(progress,previous,observedActive)){completed=true;break;}
  if(!progress.isActive&&/fail|error/i.test(progress.stage))throw Error('知识库解析失败：'+progress.message);
  await page.waitForTimeout(1000);
 }
 const diagnostic=await knowledgeParserDiagnostic(created.wiki_dir);
 if(diagnostic){
  await fs.writeFile(path.join(dir,'知识库解析诊断.json'),JSON.stringify(diagnostic,null,2));
  throw blocked('文档解析运行时无法启动'+(diagnostic.exitCodeHex?'（'+diagnostic.exitCodeHex+'）':'')+'；解析进度终态不能代替真实Wiki产物');
 }
 if(!completed)throw blocked('观察期限内本轮知识库解析未取得真实终态，保留材料及解析进度');
 assert('本轮知识库解析已进入真实终态',true,progress);
 const entries=(await fs.readdir(created.wiki_dir,{recursive:true,withFileTypes:true})).filter(item=>item.isFile()&&/\.md$/i.test(item.name)),files=[];
 for(const entry of entries){const file=path.join(entry.parentPath,entry.name);files.push({path:file,text:await fs.readFile(file,'utf8')});}
 await fs.writeFile(path.join(dir,'实际Wiki产物索引.json'),JSON.stringify(files.map(item=>({path:item.path,characters:item.text.length})),null,2));
 assert('解析实际生成Wiki文件',files.length>0,files.map(item=>item.path));
 await capture('知识库真实解析终态');log('知识库实际产物已读取',created.name+'；Wiki文件='+files.length);
 return {progress,files,text:files.map(item=>item.text).join('\n'),observedActive};
}
