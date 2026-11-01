import {closeOwnedCaseReplay} from './mobilework-case-library.mjs';
import {releaseKnowledgeSelection} from './mobilework-knowledge-source-ui.mjs';
import {releaseKnowledgeCreation} from './mobilework-knowledge-resources.mjs';
import {releaseKanbanResources} from './mobilework-kanban.mjs';
import {clearModuleHandoff} from './mobilework-module-handoff.mjs';
import {snapshotDraft,modalDialogs} from './mobilework-isolation.mjs';
import {settleSkillReload} from './mobilework-skill-resources.mjs';

const reloadDialog=page=>page.getByRole('dialog').filter({visible:true}).filter({hasText:'配置已更新，需要重新加载引擎'});
export async function settleModuleReload({page,capture,log}){
 if(!await reloadDialog(page).count())return;
 await capture('模块操作中的引擎重载确认');
 await settleSkillReload(page);
 log('保留运行会话，延后引擎重载','选择等待会话结束后生效');
}

// Reload authenticates the renderer again and can restore its empty new-task
// route. Wait for the real sidebar, then re-enter only this owned module.
export async function reloadOwnedModule(page,resources){
 const owned=resources.moduleNavigation;
 const entry={'#/automation':'自动化: 任务编排','#/explore':'案例库: 实例与回放','#/knowledge':'知识中心: 知识沉淀'}[owned?.targetHash];
 if(!entry||new URL(page.url()).hash!==owned.targetHash)throw Error('重载前模块归属不匹配');
 await page.reload({waitUntil:'commit'});
 const navigation=page.getByRole('button',{name:entry,exact:true}).filter({visible:true});
 await navigation.waitFor({timeout:90000});
 await settleSkillReload(page,{waitForPrompt:true});
 // Inspect one snapshot: the notice may arrive just after the optional wait.
 // A known reload notice must not be relabelled as an unknown modal.
 const dialogs=await modalDialogs(page).allTextContents();
 if(dialogs.length){
  if(dialogs.length===1&&dialogs[0].includes('配置已更新，需要重新加载引擎'))await settleSkillReload(page);
  else throw Object.assign(Error('模块重载后存在未知弹框，保留现场'),{blocked:true});
 }
 if(new URL(page.url()).hash!==owned.targetHash){
  if(page.url()!==owned.originUrl)throw Error('模块重载后未回到登记的空任务页，保留现场');
  const draft=await snapshotDraft(page);
  if(draft.text||draft.skills.length||draft.selection.length)throw Error('模块重载后发现未知草稿，未覆盖');
  await navigation.click();
 }
 await page.waitForURL(url=>url.hash===owned.targetHash);
}

export async function restoreModuleNavigation(page,resources,options={}){
 const kanbanIds=resources.kanban?[...resources.kanban.beforeIds,resources.kanban.id].filter(Boolean):[];
 await releaseKanbanResources(page,resources,{...options,endpoint:options.endpoint||(options.cdpPort?'http://127.0.0.1:'+options.cdpPort:undefined)});
 await releaseKnowledgeSelection(page,resources);
 await releaseKnowledgeCreation(page,resources,'knowledgeSecondaryCreation');
 await releaseKnowledgeCreation(page,resources);
 await closeOwnedCaseReplay(page,resources);
 const owned=resources.moduleNavigation;
 if(!owned)return;
 const current=new URL(page.url());
 if(page.url()!==owned.originUrl){
  const hash=current.hash.split('?')[0],kanban=owned.targetHash==='#/kanban'&&kanbanIds.some(id=>hash==='#/kanban/'+id);
  const handedOff=await clearModuleHandoff(page,resources);
  if(!['#/experts',owned.targetHash].includes(hash)&&!kanban&&!handedOff)throw Error('模块页面已离开本轮入口，保留现场');
  // All supported module routes live in the same shell document. A hash
  // navigation restores the page without re-authenticating the whole app.
  await page.evaluate(url=>{location.hash=new URL(url).hash;},owned.originUrl);
  await page.waitForURL(owned.originUrl);
  await page.getByRole('button',{name:'运行任务',exact:true}).filter({visible:true}).waitFor();
 }
 delete resources.moduleNavigation;
}
