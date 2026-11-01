import {snapshotDraft} from './mobilework-isolation.mjs';

export async function openExpertWorkspace(context,{section,targetHash,handoff}){
 const {page,resources,checkpointResources}=context;
 const draft=await snapshotDraft(page);
 if(draft.text||draft.skills.length||draft.selection.length)throw Object.assign(Error('模块检查前输入区未清空，保留当前草稿'),{blocked:true});
 resources.moduleNavigation={originUrl:draft.url,targetHash,...(handoff?{handoff}:{})};await checkpointResources();
 await page.getByRole('button',{name:'专家工作区: 专家 / 技能 / 工具',exact:true}).click();
 await page.getByRole('button',{name:section,exact:true}).filter({visible:true}).click();
 await page.waitForURL(url=>url.hash.split('?')[0]===targetHash);
}

export const marketCard=(page,name)=>page.locator('div[role="button"]').filter({visible:true}).filter({has:page.getByText(name,{exact:true})});

export async function searchMarketCard(page,name){
 await page.locator('input[placeholder="请输入关键词查询"]').filter({visible:true}).fill(name);
 await page.waitForFunction(name=>{
  const shown=e=>e.getClientRects().length>0;
  return [...document.querySelectorAll('div[role="button"]')].some(card=>shown(card)&&[...card.querySelectorAll('*')].some(e=>!e.children.length&&e.textContent.trim()===name))||[...document.querySelectorAll('main *')].some(e=>shown(e)&&!e.children.length&&e.textContent.includes('没有找到与「'+name+'」匹配'));
 },name,{timeout:45000});
 const empty=page.getByText('没有找到与「'+name+'」匹配',{exact:false}).filter({visible:true});
 if(await empty.count())throw Object.assign(Error('市场没有找到目标：'+name+'；本条业务未执行'),{blocked:true});
 const card=marketCard(page,name);await card.waitFor({timeout:45000});
 return card;
}

// Read the selected card's real product input, without invoking its callback.
// The renderer's oI/P_t/B_t/M2r path uses camelCase preset fields and the normal
// asset detail response; the package's default_prompt is a different source.
export async function readExpertSummonPrompt(target,name){
 return target.evaluate(async(node,name)=>{
  let fiber=node[Object.keys(node).find(key=>key.startsWith('__reactFiber$'))];
  while(fiber&&fiber.type?.name!=='F_t')fiber=fiber.return;
  const entry=fiber?.memoizedProps?.entry,preset=entry?.preset;
  if(entry?.assetName!==name||typeof entry.assetId!=='string'||!entry.assetId||typeof preset?.name!=='string'||!preset.name)throw Error('未读取到当前专家卡片的真实召唤输入');
  const evidence={assetId:entry.assetId,title:preset.name,presetId:preset.id,defaultPrompt:preset.defaultPrompt??null,quickPrompts:preset.quickPrompts??null,detailPrompts:null};
  const direct=preset.defaultPrompt?.trim();
  if(direct)return {...evidence,expectedText:direct,source:'preset.defaultPrompt'};
  const fetched=await window.__MOBILEWORK__.invoke('assets:fetch',{path:'/asset/api/v1/platform/assets/'+encodeURIComponent(entry.assetId)+'/detail',method:'GET'});
  if(fetched.ok===false||fetched.status!==200)throw Error('专家召唤预填依据的资产详情读取失败');
  const bytes=fetched.bodyBytes?new Uint8Array(fetched.bodyBytes):Uint8Array.from(atob(fetched.bodyBase64),char=>char.charCodeAt(0));
  const response=JSON.parse(new TextDecoder().decode(bytes));
  if(response.code!==200)throw Error('专家召唤预填依据的资产详情业务失败：'+response.code);
  const detail=response.data?.expertDetail;
  const fromDetail=Array.isArray(detail)?detail:detail&&typeof detail==='object'?(detail.promptExamples??detail.quickPrompts):undefined;
  evidence.detailPrompts=Array.isArray(fromDetail)?fromDetail:null;
  const chosen=evidence.detailPrompts??preset.quickPrompts;
  const prompts=(Array.isArray(chosen)?chosen:[]).map(value=>typeof value==='string'?value.trim():'').filter(Boolean).slice(0,3);
  return {...evidence,expectedText:prompts[0]??'帮我用'+preset.name+'处理这个任务',source:prompts.length?(evidence.detailPrompts!==null?'detail.expertDetail':'preset.quickPrompts'):'product.title-fallback'};
 },name);
}

// Installed app-DqjcqLuT.js:
// W5r filters loaded pages locally; G5r virtualizes them; R8 owns normal paging.
// Read committed React props only; never invoke loadMore or mutate component state.
export async function searchSkillMarketCard(page,name){
 const search=page.locator('input[placeholder="请输入关键词查询"]').filter({visible:true});
 await search.fill(name);
 const input=await search.elementHandle(),observations=[];
 try{
  const snapshot=async()=>{
   const handle=await page.waitForFunction(({input,name})=>{
    if(!input.isConnected||input.value!==name)return false;
    let host=input[Object.keys(input).find(key=>key.startsWith('__reactFiber$'))];
    while(host?.return)host=host.return;
    const root=host?.stateNode?.current;if(!root)return false;
    const descendants=fiber=>{
     const result=[],pending=[fiber];
     while(pending.length){const item=pending.pop();result.push(item);for(let child=item.child;child;child=child.sibling)pending.push(child);}
     return result;
    };
    const modules=descendants(root).filter(fiber=>fiber.type?.name==='W5r');
    if(modules.length!==1||modules[0].memoizedProps.query!==name)return false;
    const module=modules[0],children=descendants(module);
    // This effect is W5r's actual [market tab, query error, refetch] error notice.
    for(let hook=module.memoizedState;hook;hook=hook.next){
     const deps=hook.memoizedState?.deps;
     if(Array.isArray(deps)&&deps.length===3&&deps[0]==='market'&&deps[1] instanceof Error&&typeof deps[2]==='function')return {error:deps[1].message};
    }
    const grid=children.find(fiber=>fiber.type?.name==='G5r'),paging=children.find(fiber=>fiber.type?.name==='R8');
    if(!grid||!paging||paging.memoizedProps.loadingMore)return false;
    const sentinel=descendants(paging).find(fiber=>fiber.type==='div'&&fiber.memoizedProps?.['aria-hidden']===true)?.stateNode;
    if(!sentinel?.isConnected)return false;
    return {entries:paging.memoizedProps.entryCount,hasMore:paging.memoizedProps.hasMore,names:grid.memoizedProps.skills.map(skill=>skill.name),sentinel};
   },{input,name},{timeout:45000});
   const state=await handle.evaluate(({sentinel,...value})=>value);
   if(state.error){await handle.dispose();throw Error('技能市场加载失败：'+state.error);}
   return {handle,state};
  };
  while(true){
   const {handle,state}=await snapshot();observations.push(state);
   try{
    if(state.names.includes(name)){
     const scroller=page.locator('[data-mw-module-scroll]').filter({visible:true});
     await scroller.evaluate(node=>{node.scrollTop=0;});
     const card=page.locator('div[role="button"]').filter({visible:true}).filter({has:page.getByText(name,{exact:true})});
     await card.waitFor();return {card,observations};
    }
    if(!state.hasMore)return {card:null,observations};
    const property=await handle.getProperty('sentinel'),sentinel=property.asElement();
    try{await sentinel.scrollIntoViewIfNeeded();}finally{await property.dispose();}
    await page.waitForFunction(({input,entries})=>{
     let host=input[Object.keys(input).find(key=>key.startsWith('__reactFiber$'))];while(host?.return)host=host.return;
     const pending=[host.stateNode.current];
     while(pending.length){
      const fiber=pending.pop();
      if(fiber.type?.name==='R8'&&fiber.memoizedProps.entryCount!==undefined){const p=fiber.memoizedProps;return p.entryCount>entries||!p.hasMore;}
      for(let child=fiber.child;child;child=child.sibling)pending.push(child);
     }
     return false;
    },{input,entries:state.entries},{timeout:45000});
   }finally{await handle.dispose();}
  }
 }finally{await input.dispose();}
}
