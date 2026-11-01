const blocked=message=>Object.assign(Error(message),{blocked:true});

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
