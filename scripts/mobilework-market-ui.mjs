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
