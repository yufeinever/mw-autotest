// Read the same staff service as the product. Authentication remains in the
// client's main process; neither the executor nor reports receive credentials.
export async function readStaffService(page,route,params={}){
 return page.evaluate(async({route,params})=>{
  const {portal}=await (window.__MOBILEWORK_ELECTRON__ ?? window.__OPENWORK_ELECTRON__).invokeDesktop('runtimeEndpoints');
  if(!portal)throw Error('数智员工门户地址未配置');
  const query=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));
  const response=await window.__MOBILEWORK__.invoke('assets:fetch',{path:portal.replace(/\/+$/,'')+'/mw2yunxi'+route+(query.size?'?'+query:''),method:'GET'});
  if(!response.ok)throw Error('数智员工读取失败：'+route);
  const bytes=response.bodyBytes?new Uint8Array(response.bodyBytes):Uint8Array.from(atob(response.bodyBase64),c=>c.charCodeAt(0));
  const body=JSON.parse(new TextDecoder().decode(bytes));
  if(response.status!==200||body.code!==200)throw Error('数智员工接口状态异常：'+route+' HTTP '+response.status+' code '+body.code);
  return body;
 },{route,params});
}

export const marketRoutes={list:'/agentmgr/client/inner/agent/query',domains:'/agentmgr/client/agent/business/count',organizations:'/rbacmgr/api/web/org/superior/0'};
export const marketQuery={canOrder:true,levelLabel:2,orderSort:4};
export const staffIdentity=({agentName,orgName,createUserName,businessTypeName,tagList})=>({name:agentName,company:[orgName,createUserName].filter(Boolean).join(' / '),domain:businessTypeName||tagList?.[0]||'通用'});
export const sameStaffCards=(actual,expected)=>{
 const keys=items=>items.map(item=>JSON.stringify(item)).sort();
 return JSON.stringify(keys(actual))===JSON.stringify(keys(expected.map(staffIdentity)));
};

export async function readMarketCards(page){
 return page.locator('.mw-staff-content [class~="group/employee-card"]').evaluateAll(cards=>cards.map(card=>({
  name:card.querySelector('[class*="staff-market-card-name"]').textContent,
  company:card.querySelector('[class*="staff-market-card-company"]').textContent,
  domain:card.querySelector('[class*="staff-market-card-stat"] > span:first-child span').textContent
 })));
}

export async function readAllMarketStaff(page,filters={}){
 const params={...marketQuery,...filters,pageSize:40};
 const first=await readStaffService(page,marketRoutes.list,{...params,pageNum:1}),items=[...first.data];
 for(let pageNum=2;pageNum<=Math.ceil(first.total/params.pageSize);pageNum++){
  const response=await readStaffService(page,marketRoutes.list,{...params,pageNum});
  if(response.total!==first.total)throw Object.assign(Error('市场数据在分页读取中变化，需重新取样，未对不同版本集合做断言'),{review:true});
  items.push(...response.data);
 }
 return {total:first.total,items};
}

export async function expandMarketDomains(page){
 const bar=page.locator('.mw-staff-content > div').first().locator(':scope > div').first();
 if(!(await bar.getAttribute('class')).includes('flex-wrap')){
  const toggle=bar.locator('button').filter({hasText:/^$/});
  if(await toggle.count())await toggle.click();
 }
 return bar;
}

export async function waitMarketList(page){
 const content=page.locator('.mw-staff-content');
 await content.getByText('加载中...',{exact:true}).waitFor({state:'hidden',timeout:45000});
 await content.locator('[class~="group/employee-card"]').first().or(content.getByText('暂无数据',{exact:true})).waitFor({timeout:45000});
}

// A click can precede React replacing the previous list. Wait for the expected
// batch rather than accepting a previous domain's already-completed footer.
export async function waitMarketCards(page,items){
 await page.waitForFunction(expected=>{
  const cards=[...document.querySelectorAll('.mw-staff-content [class~="group/employee-card"]')].map(card=>({name:card.querySelector('[class*="staff-market-card-name"]').textContent,company:card.querySelector('[class*="staff-market-card-company"]').textContent,domain:card.querySelector('[class*="staff-market-card-stat"] > span:first-child span').textContent}));
  return JSON.stringify(cards)===JSON.stringify(expected);
 },items.map(staffIdentity),{timeout:45000});
}

export async function readCompleteMarketUI(page,expectedTotal){
 const content=page.locator('.mw-staff-content');
 await waitMarketList(page);
 const scroller=content.locator('div.h-full.overflow-y-auto');
 const deadline=Date.now()+240000;
 while(!await content.getByText('已经到底了~',{exact:true}).isVisible()){
  if(Date.now()>deadline)throw Object.assign(Error('市场列表4分钟内未完成分页，保留已加载数据，不能以首屏代表全量'),{blocked:true});
  const before=await readMarketCards(page);
  await scroller.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.waitForFunction(count=>document.querySelectorAll('.mw-staff-content [class~="group/employee-card"]').length!==count||document.querySelector('.mw-staff-content')?.innerText.includes('已经到底了~'),before.length,{timeout:45000});
 }
 const cards=await readMarketCards(page);
 if(cards.length>expectedTotal)throw Error('市场UI加载数量超过接口总数');
 return cards;
}
