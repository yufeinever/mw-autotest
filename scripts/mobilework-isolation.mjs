import {waitStep} from './mobilework-run-policy.mjs';
import {readComposerState,normalizeComposerText,clearComposerText} from './mobilework-composer.mjs';

export const editorOf=page=>page.locator('[contenteditable="true"]').filter({visible:true});
export const selectionState=page=>page.locator('[data-composer-toolbar-item]').filter({visible:true}).locator('[role="button"][aria-label^="退出"]').evaluateAll(es=>es.map(e=>({item:e.closest('[data-composer-toolbar-item]').getAttribute('data-composer-toolbar-item'),exit:e.getAttribute('aria-label')})));
export async function snapshotDraft(page,editor=editorOf(page)){
 return {url:page.url(),...await readComposerState(editor),selection:await selectionState(page),previousSelection:[]};
}
export async function resetComposerPermission(page,{stepInterval=0.5}={}){
 // Approval policy is applied to this task's prompts, not inherited from a
 // previous task that enabled full access. Only touch an empty new composer.
 const editor=editorOf(page);
 if(await editor.count()!==1)throw Error('新任务输入框不唯一');
 const state=await readComposerState(editor);
 if(state.text||state.skills.length)throw Error('新任务输入框不是空白，未修改权限');
 const trigger=page.locator('button[aria-label="权限"]').filter({visible:true});
 if(await trigger.count()!==1)throw Error('无法唯一核对本任务权限选择器');
 if((await trigger.innerText()).includes('完全访问权限')){
  await waitStep(page,{stepInterval});await trigger.click();
  const option=page.getByRole('button',{name:'默认权限',exact:true}).filter({visible:true});
  await waitStep(page,{stepInterval});await option.click({timeout:3000});
 }
 if(!(await trigger.innerText()).includes('默认权限'))throw Error('本任务默认权限未生效，未继承上一任务完全访问设置');
}
export async function draftOwnership(page,owned){
 if(!owned)return {matches:false,reason:'缺少本次草稿归属记录'};
 if(page.url()!==owned.url)return {matches:false,reason:'页面地址与本次草稿不一致'};
 if(await page.locator('[role="dialog"],[role="alertdialog"]').filter({visible:true}).count())return {matches:false,reason:'客户端仍有弹窗'};
 const editor=editorOf(page);if(await editor.count()!==1)return {matches:false,reason:'可见输入框不唯一'};
 const actual=await readComposerState(editor);
 if(normalizeComposerText(actual.text)!==normalizeComposerText(owned.text))return {matches:false,reason:'草稿文字与登记内容不一致'};
 if(JSON.stringify(actual.skills)!==JSON.stringify(owned.skills))return {matches:false,reason:'Skill选择与登记内容不一致'};
 if(JSON.stringify(await selectionState(page))!==JSON.stringify(owned.selection||[]))return {matches:false,reason:'专家或团队选择与登记内容不一致'};
 return {matches:true};
}
export async function clearOwnedDraft(page,owned,{stepInterval=0.5}={}){
 if(!(await draftOwnership(page,owned)).matches)return false;
 const editor=editorOf(page);
 for(const selected of owned.selection||[]){
  if((owned.previousSelection||[]).some(s=>s.item===selected.item&&s.exit===selected.exit))continue;
  // Exit is visibility:hidden until its toolbar is hovered. Locate the visible
  // toolbar using the hidden control, then click only after it becomes visible.
  const control=page.locator('[data-composer-toolbar-item]').filter({visible:true}).filter({has:page.getByRole('button',{name:selected.exit,exact:true,includeHidden:true})});
  if(await control.count()!==1)return false;
  await waitStep(page,{stepInterval});await control.hover();await waitStep(page,{stepInterval});await control.getByRole('button',{name:selected.exit,exact:true}).click();
  await waitStep(page,{stepInterval});
  if(await page.locator('[role="dialog"],[role="alertdialog"]').filter({visible:true}).count())return false;
 }
 await clearComposerText(editor,{stepInterval});
 return true;
}
export async function inspectPageHandoff(page,{owned,allowRunning=false,allowedSelection=[],stepInterval=0.5}={}){
 const dialogs=page.locator('[role="dialog"],[role="alertdialog"]').filter({visible:true});
 if(await dialogs.count())return {ready:false,reason:'客户端仍有弹窗，未操作未知弹窗'};
 const editor=editorOf(page);
 if(await editor.count()>1)return {ready:false,reason:'输入框不唯一'};
 if(await editor.count()){
  let state=await readComposerState(editor);
  if(state.text||state.skills.length){
   const ownership=await draftOwnership(page,owned);
   if(!ownership.matches)return {ready:false,reason:'残留草稿已保留：'+ownership.reason+'；后续任务未启动'};
   if(!await clearOwnedDraft(page,owned,{stepInterval}))return {ready:false,reason:'清理前草稿或选择发生变化，已保留；后续任务未启动'};
   state=await readComposerState(editor);
   if(state.text||state.skills.length)return {ready:false,reason:'本次草稿清理未完成'};
  }
 }
 const selected=await selectionState(page);
 if(selected.length&&JSON.stringify(selected)!==JSON.stringify(allowedSelection))return {ready:false,reason:'输入区仍有专家或团队选择，不能交接'};
 if(!allowRunning)for(const name of ['停止','允许一次','跳过'])if(await page.getByRole('button',{name,exact:true}).filter({visible:true}).count())return {ready:false,reason:'当前页面仍有运行任务或交互'};
 return {ready:true,reason:'输入框、选择与弹窗已核对，可交接'};
}
