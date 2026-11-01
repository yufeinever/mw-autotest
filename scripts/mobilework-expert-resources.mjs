import {clearOwnedDraft,composerFieldOf} from './mobilework-isolation.mjs';
import {marketCard} from './mobilework-market-ui.mjs';
import {settleSkillReload} from './mobilework-skill-resources.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});

export async function readExpertCatalog(page){
 const data=await page.evaluate(()=>window.__MOBILEWORK__.invoke('experts:catalogList'));
 if(!data.ok)throw Error('读取专家目录失败：'+(data.errorCode||data.error));
 return data.entries;
}

export async function waitForExpertInstall(page,owned){
 const target=marketCard(page,owned.installTarget),deadline=Date.now()+90000;
 if(await target.count()!==1)throw blocked('本轮专家安装卡片不在当前页面，保留安装归属');
 await settleSkillReload(page);await target.hover();
 while(Date.now()<deadline){
  await settleSkillReload(page);
  const installing=target.getByRole('status',{name:'召唤',exact:true}).filter({visible:true});
  const ready=target.locator('button[aria-label="召唤"]:not([aria-busy="true"]):not([disabled])');
  if(!await installing.count()&&await target.getByText('已安装',{exact:true}).filter({visible:true}).count()===1&&await ready.count()===1){
   const added=(await readExpertCatalog(page)).filter(entry=>entry.name===owned.installTarget&&!owned.installedBefore.includes(entry.id));
   if(added.length!==1)throw blocked('已安装专家卡片未对应唯一的本轮新增包，保留归属');
   return added[0];
  }
  await page.waitForTimeout(500);
 }
 throw blocked('本轮专家安装、引擎校验或卡片刷新尚未完成，保留归属，不重复安装或提前卸载');
}

export async function releaseExpertResources(page,owned,{draft,config,checkpoint=async()=>{}}={}){
 if(owned.summonTarget){
  const hash=new URL(page.url()).hash;
  if(!['#/session','#/workspace/'+owned.workspaceId+'/session'].includes(hash)||await page.evaluate(()=>localStorage.getItem('openwork.react.newTaskDraftWorkspace'))!==owned.workspaceId||await composerFieldOf(page).count()!==1)throw blocked('本轮专家仍在召唤，等待返回所属空间的新任务后收尾，未提前卸载安装包');
  if(!draft||draft.selection.length!==1||draft.selection[0].exit!=='退出「'+owned.summonTarget+'」')throw blocked('本轮专家缺少预登记的完整召唤草稿，未清理未知输入或提前卸载');
  if(!await clearOwnedDraft(page,draft,config))throw blocked('本轮召唤专家草稿与预登记内容不符，保留现场');
 }
 if(owned.installTarget){
  if(owned.installPending){await waitForExpertInstall(page,owned);owned.installPending=false;await checkpoint();}
  const added=(await readExpertCatalog(page)).filter(e=>e.name===owned.installTarget&&!owned.installedBefore.includes(e.id));
  if(added.length>1)throw blocked('本轮目标专家有多个新增包，未卸载不确定的资源');
  if(!added.length&&owned.installPending)throw blocked('本轮专家安装尚未确认结束，保留归属并等待安装结果');
  for(const entry of added){
   if(entry.kind!=='installed')throw blocked('新增专家并非可卸载安装包，未修改内置专家');
   const result=await page.evaluate(catalogId=>window.__MOBILEWORK__.invoke('experts:uninstall',{catalogId}),entry.id);
   if(!result.ok)throw blocked('本轮专家卸载未完成：'+(result.errorCode||result.error));
   if((await readExpertCatalog(page)).some(e=>e.id===entry.id))throw blocked('本轮专家卸载后仍在目录中');
  }
 }
 await page.evaluate(owned=>{
  const key='mobilework.recentExperts';
  const current=JSON.parse(localStorage.getItem(key)||'[]'),before=JSON.parse(owned.recentBefore||'[]');
  // Summoning moves only the exercised expert to the front (up to 8 items).
  // Preserve unrelated history if another interaction changed it.
  const others=list=>list.filter(e=>!owned.touchedNames.includes(e.name));
  const actual=others(current),expected=others(before).slice(0,actual.length);
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('专家历史出现无关变化，保留现场，未覆盖用户历史');
  if(owned.recentBefore===null)localStorage.removeItem(key);else localStorage.setItem(key,owned.recentBefore);
  window.dispatchEvent(new CustomEvent('mobilework:recent-experts',{detail:before}));
 },owned);
}
