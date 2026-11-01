import {settleSkillReload} from './mobilework-skill-resources.mjs';

// Finish the shipped 4-step creation or 2-step detail tour through its real
// controls. Leave "do not show again" unchecked; do not rewrite account history.
export async function finishKnowledgeGuide(page,ready,{capture=async()=>{},log=()=>{}}={}){
 const next=page.getByRole('button',{name:/^下一步\(\d\/[24]\)$/});
 const initial=page.getByRole('dialog').filter({has:next});
 const reload=page.getByRole('dialog').filter({visible:true}).filter({hasText:'配置已更新，需要重新加载引擎'});
 while(true){
  await ready.or(initial).or(reload).first().waitFor();
  if(!await reload.count())break;
  await capture('知识库入口延迟引擎重载确认');
  await settleSkillReload(page);
  log('知识库入口确认已处理','等待会话结束后生效');
 }
 if(!await initial.count())return;
 const dialog=page.getByRole('dialog').filter({visible:true});
 await capture('知识库首次操作引导');
 const total=Number((await next.innerText()).match(/\/(\d)\)/)[1]);
 for(let step=1;step<=total;step++){
  const before=await dialog.innerText();
  if(step<total){
   await dialog.getByRole('button',{name:'下一步('+step+'/'+total+')',exact:true}).click();
   await page.waitForFunction(text=>[...document.querySelectorAll('[role="dialog"]')].filter(n=>n.getClientRects().length).some(n=>n.innerText!==text),before);
  }else{
   const checkbox=dialog.getByRole('checkbox');
   if(await checkbox.isChecked())await checkbox.uncheck();
   await dialog.getByRole('button').last().click();
   await dialog.waitFor({state:'hidden'});
  }
 }
 await ready.waitFor();
 log('知识库引导已完成','真实'+total+'步；未勾选不再提示，未改写历史');
}
