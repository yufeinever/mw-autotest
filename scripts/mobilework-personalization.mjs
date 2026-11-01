import {chooseTone} from './mobilework-conversation-settings.mjs';
const visible=locator=>locator.filter({visible:true});
const button=(page,name)=>visible(page.getByRole('button',{name,exact:true}));

export async function readPersonalization(page){
 return page.evaluate(()=>{
  const prefs=JSON.parse(localStorage.getItem('openwork.preferences'));
  return {showLoadingTips:prefs.showLoadingTips,agentTone:prefs.agentTone};
 });
}

export async function openPersonalization(page){
 const dialog=visible(page.getByRole('dialog',{name:'设置',exact:true}));
 if(!await dialog.count()){
  await page.locator('[data-testid="sidebar-account-footer"] button[data-sidebar="menu-button"][aria-haspopup="menu"]').click();
  await page.getByRole('menuitem',{name:'设置',exact:true}).click();
  await dialog.waitFor();
 }
 await button(dialog,'个性化').click();
 await dialog.getByRole('switch',{name:'加载欢迎语',exact:true}).waitFor();
 return dialog;
}

export async function closePersonalization(page){
 const close=button(page,'关闭设置');
 if(await close.count())await close.click();
}

export async function setPersonalization(page,target){
 const dialog=await openPersonalization(page);
 const toggle=dialog.getByRole('switch',{name:'加载欢迎语',exact:true});
 if((await toggle.getAttribute('aria-checked')==='true')!==target.showLoadingTips)await toggle.click();
 await chooseTone(page,dialog,target.agentTone);
 await page.waitForFunction(target=>{
  const prefs=JSON.parse(localStorage.getItem('openwork.preferences'));
  return prefs.showLoadingTips===target.showLoadingTips&&prefs.agentTone===target.agentTone;
 },target);
 const actual=await readPersonalization(page);
 await closePersonalization(page);
 return actual;
}
