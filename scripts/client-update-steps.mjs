import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {testEnvironment} from '../local-console/environment.mjs';
import {openAccountMenu,closeAccountMenu} from './mobilework-account-menu.mjs';
import {readAccountSession} from './mobilework-account-settings.mjs';
import {startUpdateObservation} from './mobilework-update-observation.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});

export async function runUpdateSteps(context){
 const {number,page,resources,control,dir,outputs}=context;
 if(number!==202&&number!==203)throw Error('更新步骤只支持202和203');
 return control.withUI(page,'VERIFYING',async()=>{
  const account=await readAccountSession(page);
  if(!account.signedIn||account.validation!=='valid')throw blocked('更新用例需要已验证登录的测试账号；未检查或触发更新');
  const available=await page.evaluate(()=>({
   updater:typeof window.__OPENWORK_ELECTRON__?.autoUpdate?.getState==='function'&&typeof window.__OPENWORK_ELECTRON__?.autoUpdate?.onState==='function',
   observerInUse:Boolean(window.__MW_UPDATE_OBSERVER__),
  }));
  if(!available.updater)throw blocked('当前客户端未提供更新状态读取与订阅；未触发更新');
  if(available.observerInUse)throw blocked('页面已有更新观察，未接管其他观察或触发更新');
  const build=JSON.parse(await fs.readFile(testEnvironment.buildInfoPath,'utf8'));
  const evidence={
   observedAt:new Date().toISOString(),
   installedBuild:{version:build.version??null,versionCode:build.versionCode??null,productVersion:build.productVersion??null},
   account:{signedIn:account.signedIn,validation:account.validation},
   samples:await startUpdateObservation(page,randomUUID(),{snapshotOnly:true}),
   checkEntry:null,
   limitations:['本次仅采样已有状态；未向版本服务发起检查，当前状态不能证明是否存在新版。'],
  };
  const name='更新状态与入口观察.json',save=()=>fs.writeFile(path.join(dir,name),JSON.stringify(evidence,null,2));
  await save();outputs.push({name:'更新状态与入口观察',path:name});
  const baseline=evidence.samples.find(sample=>sample.kind==='baseline');
  if(['checking','downloading','verifying'].includes(baseline?.state))throw blocked('客户端已有进行中的更新检查或下载，未接管该过程');
  try{
   const menu=await openAccountMenu(context);
   const entry=menu.getByRole('menuitem',{name:'检查更新',exact:true});
   const count=await entry.count();
   evidence.checkEntry={count,visible:count===1&&await entry.isVisible(),enabled:count===1&&await entry.isEnabled()};
   await save();await context.capture('账户菜单检查更新入口');
   if(number===202)context.assert('检查更新入口唯一可见且可用',evidence.checkEntry.count===1&&evidence.checkEntry.visible&&evidence.checkEntry.enabled);
  } finally {
   await closeAccountMenu(page,resources);await context.checkpointResources();
  }
  if(number===203)evidence.limitations.push('自动检查需要本轮旧版启动或自然定时事件；既有状态不能证明本轮自动触发。原表同时要求不手动干预和人工确认安装，语义待确认。');
  evidence.limitations.push('尚未核验隔离旧版与服务端新版的对应关系，安装器归属和跨进程续跑尚未接入。');
  await save();
  throw blocked(number===202
   ?'已记录当前更新状态和菜单入口；隔离旧版、服务端新版及安装器交接尚未就绪，未点击检查、下载或安装，完整更新目标未执行'
   :'已记录当前更新状态和菜单入口；尚无法归属本轮自动检查或安全交接安装器，原表安装确认语义待核对，完整更新目标未执行');
 });
}
