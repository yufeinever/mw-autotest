import {createHash} from 'node:crypto';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const hash=value=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex');
const registryPath=workspaceId=>'connectors/registry/'+workspaceId+'.json';

async function readRegistry(page,workspaceId){
 return page.evaluate(async storePath=>{
  const invoke=window.__MOBILEWORK__.invoke;
  const auth=await invoke('auth:current');
  const global=await invoke('mcp:list');
  const {value}=await invoke('store:read',{accountId:auth.account.id,path:storePath,fallback:{}});
  return {accountId:auth.account.id,global,account:value};
 },registryPath(workspaceId));
}

// Only unconfigured entries can be exercised. No existing credentials are
// copied into checkpoints; metadata is matched by hash and kept in the client.
export async function prepareToolResources(page,{name,workspaceId,projectDir,sample}){
 const data=await readRegistry(page,workspaceId),servers=data.global.servers;
 const ids=[...new Set([...Object.keys(servers),...Object.keys(data.account)])];
 const matching=ids.filter(id=>servers[id]?.custom?.name===name||data.account[id]?.custom?.name===name);
 if(matching.length>1)throw blocked('目标工具配置不唯一，未修改：'+name);
 const id=matching[0]||null,global=id?servers[id]:undefined,account=id?data.account[id]:undefined;
 if(global&&Object.keys(global).some(key=>!['custom','updatedAt'].includes(key)))throw blocked('目标工具已有配置，保留用户密钥及连接：'+name);
 if(account&&(Object.keys(account).some(key=>!['custom','connected','lifecycleState'].includes(key))||account.connected||account.lifecycleState==='configured'))throw blocked('目标工具已有账户配置，未覆盖：'+name);
 return {name,workspaceId,projectDir,sample,id,baselineIds:ids,accountId:data.accountId,
  hadGlobal:Boolean(global),globalCustomHash:hash(global?.custom),globalCustomKeys:Object.keys(global?.custom||{}),
  accountBefore:account?{keys:Object.keys(account),customHash:hash(account.custom),customKeys:Object.keys(account.custom||{}),connected:account.connected,lifecycleState:account.lifecycleState}:null,
  disabledBefore:Object.entries(data.global.workspaceOverrides).filter(([,value])=>value.disabled?.includes(id)).map(([key])=>key),connecting:false};
}

export async function readOwnedToolState(page,owned){
 const data=await readRegistry(page,owned.workspaceId);
 if(data.accountId!==owned.accountId)throw blocked('工具测试期间登录账户已变化，保留配置待原账户恢复');
 const matches=Object.entries(data.global.servers).filter(([,entry])=>entry.custom?.name===owned.name);
 if(matches.length!==1)throw blocked('未找到唯一的本轮工具元数据：'+owned.name);
 const [id,entry]=matches[0];
 if(owned.id&&id!==owned.id||!owned.id&&owned.baselineIds.includes(id))throw blocked('工具注册标识与本轮基线不一致');
 const account=data.account[id];
 return {id,lifecycle:account?.lifecycleState||'',connected:account?.connected===true,
  secretSaved:Object.values(entry.secrets||{}).length>0&&Object.values(entry.secrets).every(value=>value===owned.sample),
  enabled:entry.server?.enabled===true,hasServer:Boolean(entry.server)};
}

export async function releaseToolResources(page,owned){
 const data=await readRegistry(page,owned.workspaceId);
 if(data.accountId!==owned.accountId)throw blocked('本轮工具恢复需要原登录账户，未修改其他账户');
 let id=owned.id;
 if(!id){
  const matches=Object.entries(data.global.servers).filter(([key,entry])=>entry.custom?.name===owned.name&&!owned.baselineIds.includes(key));
  if(matches.length>1)throw blocked('本轮工具存在多个新增配置，未执行不确定清理');
  id=matches[0]?.[0];
  if(!id)return;
 }
 const entry=data.global.servers[id],account=data.account[id];
 if(owned.connecting&&(!entry?.server||!['connected','disconnected'].includes(account?.lifecycleState)))throw blocked('本轮工具后台连接终态尚未确认，等待结束后恢复，未提前删除配置');
 if(entry&&Object.values(entry.secrets||{}).some(value=>value!==owned.sample))throw blocked('本轮工具密钥被其他操作修改，未删除未知配置');
 if(account&&Object.values(account.secrets||{}).some(value=>value!==owned.sample))throw blocked('本轮账户工具密钥已变化，未覆盖');
 // The renderer appends connected/lifecycleState/secretsReady/isCustom to the
 // cached manifest on save. Restore the original manifest's keys, by hash.
 const custom=owned.hadGlobal&&entry?Object.fromEntries(owned.globalCustomKeys.map(key=>[key,entry.custom?.[key]])):entry?.custom;
 const accountCustom=owned.accountBefore?.keys.includes('custom')?Object.fromEntries(owned.accountBefore.customKeys.map(key=>[key,account?.custom?.[key]])):undefined;
 if(owned.hadGlobal&&entry&&hash(custom)!==owned.globalCustomHash)throw blocked('原有工具元数据已变化，保留现场待复核');
 if(owned.accountBefore?.keys.includes('custom')&&hash(accountCustom)!==owned.accountBefore.customHash)throw blocked('原有账户工具元数据已变化，未覆盖');
 const disabled=Object.entries(data.global.workspaceOverrides).filter(([,value])=>value.disabled?.includes(id)).map(([key])=>key);
 if(JSON.stringify(disabled.sort())!==JSON.stringify([...owned.disabledBefore].sort()))throw blocked('工具空间开关出现无关变化，未清理配置');
 const next={...data.account};
 if(owned.accountBefore){
  const restored={};
  for(const key of owned.accountBefore.keys)restored[key]=key==='custom'?accountCustom:owned.accountBefore[key];
  next[id]=restored;
 }else delete next[id];
 await page.evaluate(async({owned,id,custom,next,storePath})=>{
  const invoke=window.__MOBILEWORK__.invoke;
  const removed=await invoke('engine:removeConnector',{projectDir:owned.projectDir,serverName:id});
  if(!removed.ok)throw Error('本轮工具注册移除失败');
  if(owned.hadGlobal){
   const result=await invoke('mcp:saveConnectorMeta',{serverName:id,custom});
   if(!result.ok)throw Error('原有工具元数据恢复失败');
  }
  for(const workspaceId of owned.disabledBefore){
   const result=await invoke('mcp:setWorkspaceEnabled',{serverName:id,workspaceId,enabled:false});
   if(!result.ok)throw Error('原有工具空间开关恢复失败');
  }
  const saved=await invoke('store:write',{accountId:owned.accountId,path:storePath,value:next});
  if(!saved.ok)throw Error('本轮账户工具配置恢复失败');
 },{owned,id,custom,next,storePath:registryPath(owned.workspaceId)});
 const restored=await readRegistry(page,owned.workspaceId),global=restored.global.servers[id];
 if(owned.hadGlobal?(!global||global.server||global.secrets||hash(global.custom)!==owned.globalCustomHash):Boolean(global))throw blocked('本轮全局工具配置恢复回读不一致');
 if(hash(restored.account[id])!==hash(next[id]))throw blocked('本轮账户工具配置恢复回读不一致');
}
