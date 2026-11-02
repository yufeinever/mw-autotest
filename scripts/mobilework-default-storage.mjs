import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {workspaces,prepareWorkspaceResources} from './mobilework-workspaces.mjs';
import {snapshotDraft} from './mobilework-isolation.mjs';
import {waitForReloadedShell} from './mobilework-skill-resources.mjs';
import {readEngineConnection,engineRequest} from '../local-console/engine-client.mjs';
const blocked=message=>Object.assign(Error(message),{blocked:true});
const key=value=>path.resolve(value).toLowerCase();
export function validateSystemStorage(value,previous){
 const stages=['prepared','submitted','settled','rejected','restoring'];
 if(!/^[a-f0-9-]{36}$/.test(value.owner)||typeof value.originUrl!=='string'||!value.originalDefault?.id||typeof value.originalDefault.name!=='string'||!path.isAbsolute(value.originalDefault.path)||!path.isAbsolute(value.targetPath)||value.oldScratch!==null&&typeof value.oldScratch!=='string'||!stages.includes(value.stage)||Object.keys(value).some(k=>!['owner','originUrl','originalDefault','targetPath','oldScratch','stage'].includes(k)))throw Error('默认空间存储恢复归属无效');
 if(previous&&(['owner','originUrl','targetPath','oldScratch'].some(k=>value[k]!==previous[k])||JSON.stringify(value.originalDefault)!==JSON.stringify(previous.originalDefault)||value.stage!==previous.stage&&!({prepared:['submitted'],submitted:['settled','rejected'],settled:['restoring'],rejected:[],restoring:[]}[previous.stage]?.includes(value.stage))))throw Error('不能替换默认空间存储恢复基线或终态');
}
export async function prepareSystemStorage(context){
 const {items}=await workspaces(context.page),defaults=items.filter(item=>item.isDefault&&item.workspaceType!=='remote');if(defaults.length!==1)throw blocked('未确认唯一已有本地默认空间，未改全局存储路径');
 const states=await engineRequest(await readEngineConnection(context.page),'/session/status');if(Object.values(states).some(item=>item.type!=='idle'))throw blocked('仍有进行中任务，未更改默认空间');
 const targetPath=path.join(context.dir,'本轮默认工作空间'),oldScratch=await context.page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences')).scratchFolderPath??null);
 if(items.some(item=>key(item.path)===key(targetPath)))throw blocked('本轮目标已注册，未接管既有空间');
 await fs.mkdir(targetPath);const {id,name,path:originalPath}=defaults[0];
 const owned={owner:randomUUID(),originUrl:context.page.url(),originalDefault:{id,name,path:originalPath},targetPath,oldScratch,stage:'prepared'};validateSystemStorage(owned);
 context.resources.systemStorage=owned;context.resources.workspaceResources=await prepareWorkspaceResources(context.page,{target:{name:'默认工作空间',path:targetPath}});await context.checkpointResources();return owned;
}
export async function settleSystemStorage(page,resources,{timeout=60000}={}){
 const owned=resources.systemStorage;validateSystemStorage(owned);const deadline=Date.now()+timeout;
 do{const {items}=await workspaces(page),matches=items.filter(item=>!resources.workspaceResources.beforeIds.includes(item.id)&&key(item.path)===key(owned.targetPath));if(matches.length>1)throw blocked('本轮新默认空间不唯一，保留归属');if(matches.length===1&&matches[0].isDefault&&items.filter(item=>item.isDefault).length===1){owned.stage='settled';return matches[0];}await page.waitForTimeout(200);}while(Date.now()<deadline);
 throw blocked('本轮默认空间创建/切换仍未确认，保留归属等待恢复');
}
async function mutate(api,route,body){const response=await fetch(api.base+route,{method:'PATCH',headers:api.headers,...(body?{body:JSON.stringify(body)}:{})});if(!response.ok)throw blocked('恢复默认空间元数据失败：HTTP '+response.status);}
export async function restoreSystemStorageMetadata(page,resources,{checkpoint}={}){
 const owned=resources.systemStorage;if(!owned)return;validateSystemStorage(owned);
 let current=await workspaces(page),target=current.items.find(item=>!resources.workspaceResources.beforeIds.includes(item.id)&&key(item.path)===key(owned.targetPath));
 if(owned.stage==='submitted'){target=await settleSystemStorage(page,resources);await checkpoint();current=await workspaces(page);}
 const original=current.items.find(item=>item.id===owned.originalDefault.id),expectedOldName=path.basename(owned.originalDefault.path)+'(原默认)';
 if(!original||key(original.path)!==key(owned.originalDefault.path)||![owned.originalDefault.name,expectedOldName].includes(original.name)||current.items.some(item=>item.isDefault&&item.id!==original.id&&item.id!==target?.id))throw blocked('默认空间或原名称已被其他操作改变，未覆盖');
 const scratch=await page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences')).scratchFolderPath??null);
 if(scratch!==owned.oldScratch&&(typeof scratch!=='string'||key(scratch)!==key(owned.targetPath)))throw blocked('存储偏好已被其他操作修改，未覆盖');
 if(owned.stage==='settled'){owned.stage='restoring';await checkpoint();}
 if(!original.isDefault)await mutate(current.api,'/workspaces/'+encodeURIComponent(original.id)+'/default');
 if(original.name!==owned.originalDefault.name)await mutate(current.api,'/workspaces/'+encodeURIComponent(original.id)+'/display-name',{displayName:owned.originalDefault.name});
 current=await workspaces(page);if(!current.items.some(item=>item.id===original.id&&item.isDefault&&item.name===owned.originalDefault.name))throw blocked('原默认空间身份与名称恢复未确认');
}
export async function releaseSystemStorage(page,resources,{checkpointPage}){
 const owned=resources.systemStorage;if(!owned)return;validateSystemStorage(owned);
 const current=await workspaces(page),original=current.items.find(item=>item.id===owned.originalDefault.id);
 if(!original?.isDefault||current.items.filter(item=>item.isDefault).length!==1||key(original.path)!==key(owned.originalDefault.path)||original.name!==owned.originalDefault.name)throw blocked('原默认空间尚未恢复，保留存储偏好归属');
 const draft=await snapshotDraft(page);
 if(draft.text||draft.skills.length||draft.selection.length)throw blocked('存储偏好恢复遇到未知草稿，保留现场');
 const scratch=await page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences')).scratchFolderPath??null);
 if(scratch!==owned.oldScratch&&(typeof scratch!=='string'||key(scratch)!==key(owned.targetPath)))throw blocked('存储偏好已被其他操作修改，未覆盖');
 const expectedUrl=page.url();await checkpointPage();
 await page.evaluate(oldScratch=>{const key='openwork.preferences',prefs=JSON.parse(localStorage.getItem(key));if(oldScratch===null)delete prefs.scratchFolderPath;else prefs.scratchFolderPath=oldScratch;localStorage.setItem(key,JSON.stringify(prefs));},owned.oldScratch);
 await page.reload({waitUntil:'commit'});await waitForReloadedShell(page,page.getByTestId('workspace-section-header'));
 if(page.url()!==expectedUrl)throw blocked('存储偏好恢复重载后页面归属已变化，保留现场');
 const restored=await snapshotDraft(page);
 if(restored.text||restored.skills.length||restored.selection.length)throw blocked('存储偏好恢复后出现未知草稿，保留现场');
 const value=await page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences')).scratchFolderPath??null);
 if(value!==owned.oldScratch)throw blocked('重载后原存储偏好未恢复，保留收尾归属');
 const after=await workspaces(page);
 if(after.items.filter(item=>item.isDefault).length!==1||!after.items.some(item=>item.id===original.id&&item.isDefault&&item.name===owned.originalDefault.name&&key(item.path)===key(owned.originalDefault.path)))throw blocked('重载后原默认空间未确认，保留收尾归属');
 await checkpointPage();
 delete resources.systemStorage;
}
