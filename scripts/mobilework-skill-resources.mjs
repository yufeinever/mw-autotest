import {draftOwnership,editorOf,modalDialogs} from './mobilework-isolation.mjs';

const blocked=message=>Object.assign(Error(message),{blocked:true});

export async function selectSlashSkill({page,checkpointPage,getOwnedDraft},choice,id){
 const before=getOwnedDraft();
 if(!before||before.text!=='/'||before.skills.length||!(await draftOwnership(page,before)).matches)throw blocked('斜线技能选择前不是本轮已登记的单独斜线草稿，保留现场');
 const expected={...before,text:'',skills:[id]};
 await checkpointPage(expected);
 await choice.click();
 await editorOf(page).locator('[data-skill-remove='+JSON.stringify(id)+']').waitFor({state:'attached'});
 if(!(await draftOwnership(page,expected)).matches)throw blocked('斜线技能选择后的实际草稿与预登记身份不符，保留现场');
 return expected;
}

// Installed HAt picker: inspect committed props and actual keyed rows. This
// never calls product handlers or changes React state. Caller disposes element.
export async function waitForSkillPicker(page,{query='',targetId=null}={}){
 const search=page.locator('input[placeholder="输入名称搜索..."]').filter({visible:true});
 await search.waitFor();const input=await search.elementHandle();let snapshot;
 try{
  snapshot=await page.waitForFunction(({input,query,targetId})=>{
   if(!input.isConnected||input.value!==query)return false;
   const committedPath=node=>{
    const host=node[Object.keys(node).find(key=>key.startsWith('__reactFiber$'))],pending=[host,host?.alternate].filter(Boolean).map(fiber=>[fiber]),seen=new Set();
    while(pending.length){
     const chain=pending.shift(),fiber=chain.at(-1);if(seen.has(fiber))continue;seen.add(fiber);
     if(fiber.tag===3){if(fiber.stateNode.current===fiber)return chain;continue;}
     for(const parent of [fiber.return,fiber.return?.alternate]){
      if(!parent)continue;let child=parent.child;while(child&&child!==fiber)child=child.sibling;
      if(child===fiber)pending.push([...chain,parent]);
     }
    }
    return null;
   };
   const inputPath=committedPath(input),picker=inputPath?.find(fiber=>fiber.type?.name==='HAt');
   if(!picker)return false;
   const props=picker.memoizedProps,hostProps=input[Object.keys(input).find(key=>key.startsWith('__reactProps$'))];
   if(!props.open||props.loading!==false||hostProps?.value!==query)return false;
   const skills=props.skills.map(skill=>({id:skill.id,name:skill.name,displayName:skill.displayName,description:skill.description,source:skill.source,title:skill.displayName?.trim()||skill.name}));
   const keyword=query.trim().toLocaleLowerCase(),expected=skills.filter(skill=>!keyword||[skill.name,skill.displayName].filter(Boolean).some(value=>value.toLocaleLowerCase().includes(keyword)));
   const list=input.parentElement.nextElementSibling;
   const elements=[...list.querySelectorAll('button')].filter(node=>node.querySelector('span.truncate')&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');
   const items=elements.map(node=>{
    const chain=committedPath(node),owner=chain?.indexOf(picker),key=owner>=0?chain.slice(0,owner).find(fiber=>expected.some(skill=>skill.id===fiber.key))?.key:null;
    return {id:key,title:node.querySelector('span.truncate').textContent.trim(),role:node.getAttribute('role'),checked:node.getAttribute('aria-checked'),disabled:node.getAttribute('aria-disabled')==='true'};
   });
   if(items.length!==expected.length||new Set(items.map(item=>item.id)).size!==items.length)return false;
   if(items.some((item,index)=>{
    const skill=expected[index],command=skill.source==='command';
    return item.id!==skill.id||item.title!==skill.title||item.role!==(command?null:'checkbox')||item.checked!==(command?null:String((props.selectedNames||[]).includes(skill.name)));
   }))return false;
   const empty=expected.length===0&&list.textContent.trim()==='未加载skills。';
   if(!expected.length&&!empty)return false;
   return {query,loading:false,skills,expectedIds:expected.map(skill=>skill.id),items,empty,element:targetId?elements[items.findIndex(item=>item.id===targetId)]||null:null};
  },{input,query,targetId},{timeout:15000});
  const state=await snapshot.evaluate(({element,...state})=>state);
  if(!targetId)return {...state,element:null};
  const handle=await snapshot.getProperty('element'),element=handle.asElement();
  if(!element){await handle.dispose();throw blocked('完整技能候选已就绪，但未找到本轮目标ID：'+targetId);}
  return {...state,element};
 }finally{await snapshot?.dispose();await input.dispose();}
}

export async function settleSkillReload(page,{waitForPrompt=false}={}){
 const modal=page.getByRole('dialog').filter({visible:true}).filter({hasText:'配置已更新，需要重新加载引擎'});
 // Removing a skill returns before the renderer receives its reload notice.
 // The notice is optional when the engine can reload without confirmation.
 if(waitForPrompt){
  try{await modal.waitFor({state:'visible',timeout:3000});}
  catch(error){if(error.name!=='TimeoutError')throw error;return false;}
 }
 if(!await modal.count())return false;
 await modal.getByRole('button',{name:'等待会话结束后生效',exact:true}).click();
 await modal.waitFor({state:'hidden'});
 return true;
}

// Shared post-reload readiness only. Callers keep their own route/resource
// ownership contracts; this helper does not navigate or register a page.
export async function waitForReloadedShell(page,ready){
 await ready.waitFor({timeout:90000});
 await settleSkillReload(page,{waitForPrompt:true});
 const dialogs=await modalDialogs(page).allTextContents();
 if(dialogs.length){
  if(dialogs.length===1&&dialogs[0].includes('配置已更新，需要重新加载引擎'))await settleSkillReload(page);
  else throw blocked('重载后存在未知弹框，保留现场');
 }
}

export async function waitForSkillInstall(page,targetName){
 // Installation waits for the product's reload decision before updating its card.
 await page.waitForFunction(name=>{
  const dialogs=[...document.querySelectorAll('[role="dialog"]')];
  if(dialogs.some(x=>x.getClientRects().length&&x.innerText.includes('配置已更新，需要重新加载引擎')))return true;
  return [...document.querySelectorAll('div[role="button"]')].some(card=>card.getClientRects().length&&[...card.querySelectorAll('*')].some(x=>x.children.length===0&&x.textContent.trim()===name)&&[...card.querySelectorAll('button')].some(x=>x.innerText.trim()==='已安装'));
 },targetName,{timeout:90000});
 await settleSkillReload(page);
 const card=page.locator('div[role="button"]').filter({visible:true}).filter({has:page.getByText(targetName,{exact:true})});
 await card.getByRole('button',{name:'已安装',exact:true}).waitFor({timeout:30000});
}

export async function readInstalledSkills(page,projectDir){
 const result=await page.evaluate(projectDir=>window.__MOBILEWORK__.invoke('engine:listSkills',{projectDir}),projectDir);
 return result.skills;
}

export async function releaseSkillResources(page,owned){
 await settleSkillReload(page);
 const added=(await readInstalledSkills(page,owned.projectDir)).filter(id=>!owned.installedBefore.includes(id));
 if(!added.length){if(owned.pending)throw blocked('本轮技能安装尚未确认结束，保留归属等待安装结果');return;}
 if(added.length!==1||owned.id&&added[0]!==owned.id)throw blocked('新增技能与本轮安装目标不能唯一对应，未卸载不确定资源');
 if(owned.pending){
  const target=page.locator('div[role="button"]').filter({visible:true}).filter({has:page.getByText(owned.targetName,{exact:true})});
  if(await target.count()!==1||!await target.getByRole('button',{name:'已安装',exact:true}).count())throw blocked('本轮技能仍在后台安装，未提前移除目录');
 }
 const result=await page.evaluate(({projectDir,id})=>window.__MOBILEWORK__.invoke('engine:removeSkill',{projectDir,id}),{projectDir:owned.projectDir,id:added[0]});
 if(!result.ok)throw blocked('本轮新增技能卸载失败');
 await settleSkillReload(page,{waitForPrompt:true});
 if((await readInstalledSkills(page,owned.projectDir)).includes(added[0]))throw blocked('本轮新增技能卸载后仍存在');
}
