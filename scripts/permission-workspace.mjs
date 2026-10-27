import fs from 'node:fs/promises';
import path from 'node:path';

// Read the product's workspace registry, then match the visible composer.
// Never infer the selected directory from a translated label or URL alone.
export async function readPermissionWorkspace(page,{allowedRoot}){
 const registry=await page.evaluate(async()=>{
  const info=await window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo');
  return {baseUrl:info?.baseUrl,token:info?.clientToken};
 });
 const base=new URL(registry.baseUrl);
 if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password)throw Error('工作空间注册服务不是本机地址');
 if(!registry.token)throw Error('本机工作空间注册服务缺少运行时凭证');
 const response=await fetch(new URL('/workspaces',base),{headers:{Authorization:'Bearer '+registry.token},redirect:'error',signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error('读取产品工作空间列表失败：HTTP '+response.status);
 const data=await response.json(),items=data.items??data.workspaces;
 if(!Array.isArray(items))throw Error('产品工作空间列表格式不支持');
 const main=page.locator('main').last(),matches=[];
 for(const item of items){
  if(typeof item.id!=='string'||typeof item.name!=='string'||!item.name.trim())continue;
  if(await main.getByRole('button',{name:item.displayName||item.name,exact:true}).filter({visible:true}).count()===1)matches.push(item);
 }
 if(matches.length!==1)throw Error('不能唯一确认输入区所选工作空间，未选择或改名任何空间');
 const selected=matches[0];
 if(selected.workspaceType!=='local')throw Error('权限材料准备目前只支持本机工作空间，未操作远程或沙箱目录');
 const directory=await fs.realpath(selected.path||selected.directory),root=await fs.realpath(allowedRoot),relative=path.relative(root,directory);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('所选空间不在已配置测试根目录内，未写入材料；请在控制台环境配置测试根目录');
 return {id:selected.id,name:selected.displayName||selected.name,directory,source:'产品本机/workspaces注册表 + 输入区唯一可见空间按钮'};
}

export async function assertPermissionSessionDirectory(expected,actual){
 if(typeof actual!=='string'||!actual)throw Error('新Session缺少实际目录，不能确认材料归属');
 const [a,b]=await Promise.all([fs.realpath(expected),fs.realpath(actual)]);
 if(path.relative(a,b)!=='')throw Error('Session实际目录与发送前准备材料的空间不一致，已停止本次观察，不改写目录归属');
}

export async function assertPermissionTaskDirectory(workspace,actual){
 if(typeof actual!=='string'||!actual)throw Error('新Session缺少实际目录');
 const [parent,child]=await Promise.all([fs.realpath(workspace),fs.realpath(actual)]),relative=path.relative(parent,child);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('新任务目录不属于当前所选空间，未准备材料');
 return child;
}
