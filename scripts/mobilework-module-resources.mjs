import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {readInstalledSkills,settleSkillReload} from './mobilework-skill-resources.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
export const resourceHash=value=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex');

export async function readLocalSkill(page,projectDir,id){
 return page.evaluate(({projectDir,id})=>(window.__MOBILEWORK_ELECTRON__ ?? window.__OPENWORK_ELECTRON__).invokeDesktop('readLocalSkill',projectDir,id),{projectDir,id});
}

export async function releaseManagedSkills(page,owned,{modelSettled=false,checkpoint=async()=>{}}={}){
 if(owned.pending&&owned.pendingKind==='import'&&owned.pickerToken&&new URL(page.url()).hash==='#/experts/skills'&&await page.locator('html').getAttribute('data-mw-skill-picker-document')===owned.pickerToken){
  await settleSkillReload(page);
  const heading=page.getByRole('heading',{name:'上传技能',exact:true}).filter({visible:true});
  const installed=await readInstalledSkills(page,owned.projectDir);
  const added=installed.filter(id=>!owned.installedBefore.includes(id));
  if(!await heading.count()&&added.length===1&&added[0]===owned.ids[0]){
   const skill=await readLocalSkill(page,owned.projectDir,owned.ids[0]);
   const source=await fs.readFile(path.join(owned.importFolder,'SKILL.md'),'utf8');
   if(skill.content?.includes(owned.marker)&&skill.content.replace(/\r\n/g,'\n')===source.replace(/\r\n/g,'\n')){
    owned.pending=false;delete owned.pickerToken;delete owned.importFolder;await checkpoint();
   }
  }
 }
 if(owned.pending&&!(owned.pendingKind==='create'&&modelSettled)){
  throw blocked('本轮技能导入或创建尚未确认终态，保留归属等待收尾');
 }
 if(owned.pickerToken){
  if(new URL(page.url()).hash!=='#/experts/skills'||await page.locator('html').getAttribute('data-mw-skill-picker-document')!==owned.pickerToken)throw blocked('技能上传页面或文档归属已变化，保留现场');
  const heading=page.locator('[data-mw-skill-picker="'+owned.pickerToken+'"]');
  if(await heading.isVisible()){
   const modal=heading.locator('xpath=ancestor::div[.//button[normalize-space()="取消"] and .//button[normalize-space()="导入"]][1]');
   await modal.getByRole('button',{name:'取消',exact:true}).click();await heading.waitFor({state:'hidden'});
  }else if(await page.getByRole('heading',{name:'上传技能',exact:true}).filter({visible:true}).count())throw blocked('技能上传窗口未完成归属，保留现场');
  delete owned.pickerToken;delete owned.importFolder;
 }
 await settleSkillReload(page);
 const installed=await readInstalledSkills(page,owned.projectDir),added=installed.filter(id=>!owned.installedBefore.includes(id));
 if(added.some(id=>!owned.ids.includes(id)))throw blocked('存在未匹配本轮目标的新增技能，保留现场，未移除未知目录');
 for(const id of added){
  const skill=await readLocalSkill(page,owned.projectDir,id);
  if(!skill.content?.includes(owned.marker))throw blocked('新增技能缺少本轮来源标记，未移除：'+id);
  const result=await page.evaluate(({projectDir,id})=>window.__MOBILEWORK__.invoke('engine:removeSkill',{projectDir,id}),{projectDir:owned.projectDir,id});
  if(!result.ok)throw blocked('本轮合成技能移除失败：'+id);
  await settleSkillReload(page,{waitForPrompt:true});
 }
 const after=await readInstalledSkills(page,owned.projectDir);
 if(JSON.stringify([...after].sort())!==JSON.stringify([...owned.installedBefore].sort()))throw blocked('本轮技能收尾后集合与基线不一致');
}

async function customRegistry(page,workspaceId){
 return page.evaluate(async workspaceId=>{
  const invoke=window.__MOBILEWORK__.invoke,auth=await invoke('auth:current'),global=await invoke('mcp:list');
  const {value:account}=await invoke('store:read',{accountId:auth.account.id,path:'connectors/registry/'+workspaceId+'.json',fallback:{}});
  // Hash all existing values inside the renderer; credentials never leave it.
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value??null))))).map(b=>b.toString(16).padStart(2,'0')).join('');
  return {accountId:auth.account.id,globalHashes:Object.fromEntries(await Promise.all(Object.entries(global.servers).map(async([id,v])=>[id,await hash(v)]))),accountHashes:Object.fromEntries(await Promise.all(Object.entries(account).map(async([id,v])=>[id,await hash(v)]))),targets:Object.entries(account).filter(([,v])=>v.custom?.name?.startsWith('MW-AUTOTEST-')).map(([id,v])=>({id,name:v.custom.name,description:v.custom.description,mcp:{type:v.custom.mcp?.type,url:v.custom.mcp?.url,transport:v.custom.mcp?.transport,timeout:v.custom.mcp?.timeout,hasCredentials:Boolean(v.custom.mcp?.headers&&Object.keys(v.custom.mcp.headers).length||v.custom.mcp?.oauth)},connected:v.connected,lifecycleState:v.lifecycleState}))};
 },workspaceId);
}
export const readCustomToolRegistry=customRegistry;

export async function releaseCustomTool(page,owned){
 const data=await customRegistry(page,owned.workspaceId);
 if(data.accountId!==owned.accountId)throw blocked('自定义工具收尾时账号已变化');
 const added=data.targets.filter(t=>!Object.hasOwn(owned.accountHashes,t.id)&&[owned.name,owned.renamed].includes(t.name));
 if(added.length>1||owned.id&&added.some(t=>t.id!==owned.id))throw blocked('自定义工具新增归属不唯一');
 for(const tool of added){
  if(tool.connected||tool.mcp?.hasCredentials||tool.mcp?.url!==owned.url)throw blocked('本轮工具出现连接、凭据或地址变化，保留配置待复核');
  const result=await page.evaluate(({projectDir,id})=>window.__MOBILEWORK__.invoke('engine:removeConnector',{projectDir,id,serverName:id}),{projectDir:owned.projectDir,id:tool.id});
  if(!result.ok)throw blocked('本轮自定义工具删除失败');
  await page.evaluate(async({owned,id})=>{
   const invoke=window.__MOBILEWORK__.invoke,path='connectors/registry/'+owned.workspaceId+'.json';
   const {value}=await invoke('store:read',{accountId:owned.accountId,path,fallback:{}});delete value[id];
   const result=await invoke('store:write',{accountId:owned.accountId,path,value});if(!result.ok)throw Error('本轮工具账户登记清理失败');
  },{owned,id:tool.id});
 }
 const after=await customRegistry(page,owned.workspaceId);
 if(resourceHash(after.globalHashes)!==resourceHash(owned.globalHashes)||resourceHash(after.accountHashes)!==resourceHash(owned.accountHashes))throw blocked('工具收尾后基线哈希不一致，保留归属');
}
