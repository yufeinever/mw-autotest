import path from 'node:path';
import {knowledgeClient,removeOwnedKnowledge,closeKnowledgeSettings} from './mobilework-knowledge-api.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
export const sameKnowledgePath=(left,right)=>path.resolve(left).toLowerCase()===path.resolve(right).toLowerCase();
export function ownedKnowledgeCandidate(items,owned){
 const matches=items.filter(item=>!owned.beforeIds.includes(item.id)&&[owned.name,owned.renamedName].includes(item.name));
 if(matches.length>1)throw blocked('本轮知识库名称对应多个新ID，未移除注册');
 const item=matches[0];if(!item)return null;
 if(owned.id&&item.id!==owned.id)throw blocked('知识库实际ID与本轮创建记录不一致，保留现场');
 const move=owned.storageMove,migrated=move&&['submitted','completed'].includes(move.state)&&sameKnowledgePath(item.storage_dir,move.to);
 const storageDir=migrated?move.to:owned.storageDir;
 if(!sameKnowledgePath(item.storage_dir,storageDir)||!sameKnowledgePath(item.wiki_dir,path.join(storageDir,'knowledge'))||owned.sourceDir&&(item.source_dir.length!==1||!sameKnowledgePath(item.source_dir[0],owned.sourceDir)))throw blocked('新知识库路径不符合创建前归属，保留现场');
 if(migrated&&!owned.sourceDir&&(item.source_dir.length!==2||!['information','resource'].every(name=>item.source_dir.some(dir=>sameKnowledgePath(dir,path.join(storageDir,name))))))throw blocked('迁移后的源目录未对应本轮内部源，保留现场');
 if(move?.state==='submitted'&&!migrated)throw blocked('原生目录已确认但存储迁移请求结果仍未确认，保留本轮注册，未放行下一条');
 return item;
}

export const knowledgeRemovalSettled=(owned,items)=>owned.removing===true&&typeof owned.id==='string'&&!owned.beforeIds.includes(owned.id)&&!items.some(item=>item.id===owned.id);

export async function dismissOwnedKnowledgeDialog(page,owned){
 if(owned.modelMenuToken){
  const menu=page.locator('[data-mw-parse-model-owner="'+owned.modelMenuToken+'"]');
  if(await menu.count()){await menu.press('Escape');await menu.waitFor({state:'hidden'});}
  delete owned.modelMenuToken;
 }
 if(owned.graphToken){
  const root=page.locator('[data-mw-knowledge-graph-owner="'+owned.graphToken+'"]'),exit=root.getByRole('button',{name:'退出全屏',exact:true}).filter({visible:true});
  if(await exit.count()===1){await exit.click();await root.getByRole('button',{name:'全屏显示',exact:true}).waitFor();}
  delete owned.graphToken;
 }
 if(owned.previewTitle){
  const preview=page.getByRole('dialog',{name:owned.previewTitle,exact:true}).filter({visible:true});
  if(await preview.count()===1){await preview.press('Escape');await preview.waitFor({state:'hidden'});}
  delete owned.previewTitle;
 }
 if(!owned.dialogToken)return;
 const dialog=page.locator('[data-mw-knowledge-owner="'+owned.dialogToken+'"]');
 if(await dialog.count()){
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
 }
 delete owned.dialogToken;
}

export async function releaseKnowledgeCreation(page,resources,resourceKey='knowledgeCreation'){
 const owned=resources[resourceKey];if(!owned)return;
 await dismissOwnedKnowledgeDialog(page,owned);
 const call=await knowledgeClient(page),deadline=Date.now()+(owned.submitted?15000:0);let item,items;
 do{
  items=await call('/knowledge/list');item=ownedKnowledgeCandidate(items,owned);
  if(item||!owned.submitted||knowledgeRemovalSettled(owned,items))break;
  await page.waitForTimeout(200);
 }while(Date.now()<deadline);
 if(!item&&owned.submitted&&!knowledgeRemovalSettled(owned,items))throw blocked('本轮知识库创建请求结果尚未确认，保留归属等待恢复，未放行下一条');
 if(item){
  await closeKnowledgeSettings(page,{storageDir:item.storage_dir});
  if(owned.scheduleTime){
   await call('/knowledge/update_config',{id:item.id,configs:{open_update:false}});
   if((await call('/knowledge/'+item.id)).open_update!==false)throw blocked('本轮定时更新关闭未确认，未放行下一条');
  }
  await removeOwnedKnowledge(call,{id:item.id,name:item.name,storageDir:item.storage_dir});
 }
 delete resources[resourceKey];
}
