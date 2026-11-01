import fs from 'node:fs/promises';
import path from 'node:path';
import {snapshotDraft} from './mobilework-isolation.mjs';
import {restoreModuleNavigation} from './mobilework-module-navigation.mjs';
import {readStaffService,marketRoutes,marketQuery,readAllMarketStaff,readMarketCards,sameStaffCards,expandMarketDomains,waitMarketList,waitMarketCards,readCompleteMarketUI} from './mobilework-staff-market.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});
const review=message=>Object.assign(Error(message),{review:true});
const safeStaff=item=>Object.fromEntries(['id','agentName','orgName','createUserName','businessTypeId','businessTypeName','tagList'].filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));

export async function runStaffMarketSteps(context){
 const {number,page,dir,resources,remaining,assert,capture,log,checkpointResources,checkpointPage}=context;
 const save=(name,data)=>fs.writeFile(path.join(dir,name),JSON.stringify(data,null,2)),finish=name=>remaining.delete(name);
 const origin=await snapshotDraft(page);
 if(origin.text||origin.skills.length||origin.selection.length)throw blocked('数智员工检查前输入区未清空，保留当前输入');
 resources.moduleNavigation={originUrl:origin.url,targetHash:'#/experts/staff'};await checkpointResources();
 try{
  await page.getByRole('button',{name:'专家工作区: 专家 / 技能 / 工具',exact:true}).click();
  await page.getByRole('button',{name:'RPA流程助手',exact:true}).click();
  const scope=page.locator('.mw-staff-content');
  if(number===82){
   await page.getByRole('tab',{name:'我的数智员工',exact:true}).click();
   const type=scope.getByRole('combobox').filter({hasText:/单智能体员工|RPA数智员工/});
   if(!(await type.innerText()).includes('单智能体员工')){await type.click();await page.getByRole('option',{name:'单智能体员工',exact:true}).click();}
   await scope.getByText('加载中...',{exact:true}).waitFor({state:'hidden',timeout:45000});
   const cards=await scope.locator('.mw-staff-card-grid > div').allTextContents();
   await save('智能体员工前置观察.json',{at:new Date().toISOString(),count:cards.length,implemented:'真实单智能体类型与列表观察；详情、独立员工会话和移除仍待专用资源及业务接入',missing:['可丢弃且可恢复的本轮订购员工','该员工会话与日志归属接入，避免把门户对话当作本地引擎Session']});
   assert('我的数智员工可切换到单智能体类型',(await type.innerText()).includes('单智能体员工'));finish('真实单智能体员工列表');await capture('单智能体员工实际列表');
   throw blocked('尚未接入本轮可丢弃员工及门户会话归属；保留详情、对话、记录及移除完整目标，不移除既有员工');
  }
  await page.getByRole('tab',{name:'数智员工市场',exact:true}).click();await waitMarketList(page);
  const domains=(await readStaffService(page,marketRoutes.domains,{canOrder:true,levelLabel:2})).data;
  await save('市场领域基线.json',domains);
  if(!domains.length)throw blocked('账号未配置业务领域，无法验证分组及筛选');
  let bar=await expandMarketDomains(page);
  const labels=await bar.getByRole('button').allTextContents(),expected=['全部 ('+domains.reduce((n,d)=>n+d.count,0)+')',...domains.map(d=>d.businessTypeName+'('+d.count+')')];
  assert('市场全部领域标签及数量与实际服务配置一致',JSON.stringify(labels.filter(Boolean))===JSON.stringify(expected),{expected,actual:labels.filter(Boolean)});finish('真实领域配置与可见标签');
  await capture('全部领域展开及数量');
  if(number===83){
   const accountFields=await page.evaluate(async()=>Object.keys((await window.__MOBILEWORK__.invoke('auth:current')).account||{}));
   await save('账号所属组织证据边界.json',{accountFields,scope:'组织树是账号可访问组织配置，不等于账号自身组织归属；独立所属组织来源待接入'});
   log('账号组织归属待补证','当前已识别账户接口不提供所属组织；可访问组织及实际筛选继续验证，本条保留REVIEW缺口');
   const orgs=(await readStaffService(page,marketRoutes.organizations)).data[0].children;
   await save('组织配置基线.json',orgs.map(({id,orgName})=>({id,orgName})));
   if(!orgs.length)throw blocked('组织配置为空，不能验证发布单位命中');
   const toggle=scope.locator('label').filter({hasText:'发布单位'}).getByRole('switch');
   await toggle.click();assert('发布单位开关实际开启',await toggle.getAttribute('aria-checked')==='true');
   const tree=scope.locator('div').filter({has:page.locator('header').filter({hasText:'中国移动集团'})}).filter({has:page.locator('input[placeholder="请输入组织名称"]')}).last();
   await tree.getByText('组织加载中...',{exact:true}).waitFor({state:'hidden',timeout:45000});
   const actual=await tree.getByRole('button').allTextContents();
   assert('发布单位候选与账号可访问组织树一致',JSON.stringify(actual)===JSON.stringify(['全部',...orgs.map(o=>o.orgName)]),{actual,expected:orgs.map(o=>o.orgName)});
   // Select a real organization and compare UI against that exact organization query.
   const org=orgs[0];
   await tree.getByRole('button',{name:org.orgName,exact:true}).click();await waitMarketList(page);
   const filtered=await readStaffService(page,marketRoutes.list,{...marketQuery,firstOrgId:org.id,pageNum:1,pageSize:40});
   await waitMarketCards(page,filtered.data);
   const cards=await readMarketCards(page);await save('组织筛选实际结果.json',{organization:org,expected:filtered.data.map(safeStaff),cards,total:filtered.total});
   assert('组织筛选与该组织的实际首批数据一致',sameStaffCards(cards,filtered.data));
   assert('发布单位树已标记实际选择',(await tree.getByRole('button',{name:org.orgName,exact:true}).getAttribute('class')).includes('tree-active-bg'));finish('组织开关及实际筛选');await capture('发布单位筛选命中');
   await toggle.click();await waitMarketList(page);
   const unfiltered=await readStaffService(page,marketRoutes.list,{...marketQuery,pageNum:1,pageSize:40});await waitMarketCards(page,unfiltered.data);
   assert('关闭发布单位后清除组织条件',await toggle.getAttribute('aria-checked')==='false'&&await tree.count()===0&&sameStaffCards(await readMarketCards(page),unfiltered.data));finish('组织筛选恢复');
   // Every domain must really filter; do not claim this from labels alone.
   for(const domain of domains){
    bar=await expandMarketDomains(page);await bar.getByRole('button',{name:domain.businessTypeName+'('+domain.count+')',exact:true}).click();await waitMarketList(page);
    const response=await readStaffService(page,marketRoutes.list,{...marketQuery,businessTypeId:domain.businessTypeId,pageNum:1,pageSize:40});
    await waitMarketCards(page,response.data);
    const cards=await readMarketCards(page);await save('领域-'+domain.businessTypeId+'-首批核对.json',{domain,total:response.total,expected:response.data.map(safeStaff),cards});
    assert('领域实际命中且无跨域：'+domain.businessTypeName,response.total>0&&response.data.every(item=>String(item.businessTypeId)===String(domain.businessTypeId))&&sameStaffCards(cards,response.data));
   }
   finish('各业务领域实际命中');await capture('领域分组实际命中');
  }else{
   if(domains.filter(d=>d.count>0).length<2||!domains.some(d=>d.count>1))throw blocked('原表要求多个领域且至少一个领域有多员工，当前数据不足');
   const baseline=await readAllMarketStaff(page);await save('全部员工接口基线.json',{total:baseline.total,items:baseline.items.map(safeStaff)});
   assert('完整基线数量及员工ID无遗漏重复',baseline.items.length===baseline.total&&new Set(baseline.items.map(a=>a.id)).size===baseline.total);finish('真实全量基线与多领域前置');
   const domain=domains.filter(d=>d.count>1).sort((a,b)=>a.count-b.count)[0];
   bar=await expandMarketDomains(page);await bar.getByRole('button',{name:domain.businessTypeName+'('+domain.count+')',exact:true}).click();await waitMarketList(page);
   const filtered=await readAllMarketStaff(page,{businessTypeId:domain.businessTypeId});await waitMarketCards(page,filtered.items.slice(0,40));
   const cards=await readCompleteMarketUI(page,filtered.total);
   await save('领域完整筛选.json',{domain,total:filtered.total,items:filtered.items.map(safeStaff),cards});
   assert('所选领域完整展示且无跨域和重复ID',filtered.items.length===filtered.total&&filtered.total>1&&new Set(filtered.items.map(a=>a.id)).size===filtered.total&&filtered.items.every(a=>String(a.businessTypeId)===String(domain.businessTypeId))&&sameStaffCards(cards,filtered.items));finish('领域完整筛选与无重复');await capture('领域完整列表');
   bar=await expandMarketDomains(page);await bar.getByRole('button',{name:/^全部 \(/}).click();await waitMarketList(page);
   await waitMarketCards(page,baseline.items.slice(0,40));
   const allCards=await readCompleteMarketUI(page,baseline.total),after=await readAllMarketStaff(page);
   await save('点击全部后的完整列表.json',{total:after.total,items:after.items.map(safeStaff),cards:allCards});
   if(after.total!==baseline.total||!sameStaffCards(baseline.items.map(item=>({name:item.agentName,company:[item.orgName,item.createUserName].filter(Boolean).join(' / '),domain:item.businessTypeName||item.tagList?.[0]||'通用'})),after.items))throw review('筛选期间后台员工集合变化，已保留前后证据；需在稳定数据下复测，不硬判产品失败');
   assert('点击全部后逐页恢复完整可访问集合',sameStaffCards(allCards,after.items)&&allCards.length===after.total);finish('点击全部恢复完整集合');await capture('全部员工加载至真实末页');
  }
 }catch(error){
  await capture('员工市场恢复前异常现场').catch(e=>log('异常现场采集失败',e.message));
  throw error;
 }finally{await restoreModuleNavigation(page,resources);await checkpointPage();}
}
