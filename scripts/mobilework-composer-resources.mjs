import {resetComposerPermission} from './mobilework-isolation.mjs';
import {taskRow,openTaskMenu,restoreWorkbenchLayout,restorePreviewZoom} from './mobilework-task-ui.mjs';
import {setPersonalization} from './mobilework-personalization.mjs';
import {stopMessageObservation} from './mobilework-message-observer.mjs';
import {restoreMessageClipboard} from './mobilework-message-clipboard.mjs';
import {stopTodoObservation,selectTodoFilter} from './mobilework-todo-ui.mjs';
import {inspectExplorer} from './mobilework-explorer.mjs';
import {releaseWorkspaceResources,workspaceSessions,workspaceRow} from './mobilework-workspaces.mjs';
import {restoreModuleNavigation} from './mobilework-module-navigation.mjs';
import {releaseManagedSkills,releaseCustomTool} from './mobilework-module-resources.mjs';
import {releaseAutomation} from './mobilework-automation-resources.mjs';
import {releaseCaseFavorites} from './mobilework-case-library.mjs';
import {closeAccountMenu} from './mobilework-account-menu.mjs';
import {releaseAccountNetwork} from './mobilework-account-network.mjs';
import {releaseAccountExternal} from './mobilework-account-external.mjs';
import {releaseAccountObservation} from './mobilework-account-observation.mjs';
import {releaseAccountLogout} from './mobilework-account-logout.mjs';
import {releaseSettingsPanel} from './mobilework-account-settings.mjs';
import {releaseSystemSettings} from './mobilework-system-settings.mjs';
import {restoreSystemStorageMetadata,releaseSystemStorage} from './mobilework-default-storage.mjs';
import {releaseWindowClose} from './mobilework-window-close.mjs';
import {releaseInvalidDirectory} from './mobilework-storage-probe.mjs';
import {releaseAccountMemory} from './mobilework-account-memory.mjs';
import {releaseConversationSettings} from './mobilework-conversation-settings.mjs';
import {restoreHomeModel} from './mobilework-run-policy.mjs';

export const attachmentRow=(page,name)=>page.locator('div.flex.items-center.gap-2.rounded-xl').filter({visible:true}).filter({has:page.getByText(name,{exact:true})});
export const queuedRow=(page,text)=>page.getByRole('listitem').filter({visible:true}).filter({has:page.locator('span[title]').filter({hasText:text})});

// The names and URL are registered before mutation. Never clear another draft.
export async function releaseComposerResources(page,owned,config){
 await releaseWindowClose(page,owned);
 await releaseConversationSettings(page,owned,{checkpoint:config.checkpoint});
 await releaseAccountMemory(page,owned,{checkpoint:config.checkpoint});
 await releaseAccountLogout(page,owned,{checkpoint:config.checkpoint});
 await releaseSystemSettings(page,owned,{checkpoint:config.checkpoint});
 await releaseSettingsPanel(page,owned);
 await releaseAccountNetwork(owned);
 await releaseAccountObservation(page,owned);
 await closeAccountMenu(page,owned);
 await releaseAccountExternal(owned);
 if(owned.managedSkills?.pickerToken){
  await releaseManagedSkills(page,owned.managedSkills,{modelSettled:config.modelSettled,checkpoint:config.checkpoint});
  delete owned.managedSkills;await config.checkpoint?.();
 }
 await restoreModuleNavigation(page,owned,{modelSettled:config.modelSettled,cdpPort:config.cdpPort});
 if(page.url()!==owned.url)throw Error('输入区资源所在页面已变化，保留附件、排队消息与权限设置');
 if(owned.homeModel){await restoreHomeModel(page,owned.homeModel,config);delete owned.homeModel;}
 if(owned.caseFavorites){await releaseCaseFavorites(page,owned.caseFavorites);delete owned.caseFavorites;}
 if(owned.automation){await releaseAutomation(page,owned.automation);delete owned.automation;}
 if(owned.managedSkills){await releaseManagedSkills(page,owned.managedSkills,{modelSettled:config.modelSettled,checkpoint:config.checkpoint});delete owned.managedSkills;}
 if(owned.customTool){await releaseCustomTool(page,owned.customTool);delete owned.customTool;}
 if(owned.toolSelection){
  await page.getByRole('button',{name:'工具',exact:true}).filter({visible:true}).click();
  const row=page.locator('span.truncate').filter({visible:true,hasText:/^腾讯文档$/}).locator('xpath=..'),toggle=row.getByRole('switch');await toggle.waitFor();
  if((await toggle.getAttribute('aria-checked')==='true')!==owned.toolSelection.baseline)await toggle.click();
  if((await toggle.getAttribute('aria-checked')==='true')!==owned.toolSelection.baseline)throw Error('本轮工具任务选择恢复未确认');
  await page.keyboard.press('Escape');delete owned.toolSelection;
 }
 if(owned.previewFullscreen){
  if(await page.evaluate(()=>Boolean(document.fullscreenElement))){await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.fullscreenElement);}
  delete owned.previewFullscreen;
 }
 if(owned.todoObservation){await stopTodoObservation(page,owned.todoObservation);delete owned.todoObservation;}
 if(owned.workbenchFilter){await selectTodoFilter(page,owned.workbenchFilter.baseline);delete owned.workbenchFilter;}
 if(owned.explorerWindow){await inspectExplorer(owned.explorerWindow.path,{close:owned.explorerWindow.hwnd,reveal:owned.explorerWindow.reveal});delete owned.explorerWindow;}
 if(owned.previewZoom){await restorePreviewZoom(page,owned.previewZoom,config);delete owned.previewZoom;}
 if(owned.workbenchLayout){await restoreWorkbenchLayout(page,owned.workbenchLayout,config);delete owned.workbenchLayout;}
 if(owned.subSessionView){await page.getByRole('button',{name:'主会话',exact:true}).filter({visible:true}).click();delete owned.subSessionView;}
 if(owned.clipboardOwner){await restoreMessageClipboard(page,owned.clipboardOwner);delete owned.clipboardOwner;}
 if(owned.messageObservation)await stopMessageObservation(page,owned.messageObservation);
 if(owned.personalization)await setPersonalization(page,owned.personalization);
 if(owned.taskPin){
  const {title,baseline,workspaceId,sessionId}=owned.taskPin;
  if(workspaceId&&!(await workspaceSessions(page,workspaceId)).some(item=>item.id===sessionId&&item.title===title))throw Error('本轮空间置顶任务身份已变化，保留资源归属');
  const scope=workspaceId?workspaceRow(page,workspaceId):page,row=taskRow(page,title,scope);
  if(await row.count()!==1)throw Error('本轮置顶任务未唯一找到，保留资源归属');
  const pinned=await row.locator('[data-pinned-session="true"]').count()===1;
  if(pinned!==baseline){
   await openTaskMenu(page,title,scope);
   await page.getByRole('menuitem',{name:baseline?'置顶':'取消置顶',exact:true}).click();
   await row.locator('[data-pinned-session="true"]').waitFor({state:baseline?'visible':'hidden'});
  }
  delete owned.taskPin;
 }
 if(owned.queueTexts.length){
  const expand=page.locator('button[title="展开排队任务"]').filter({visible:true});
  if(await expand.count())await expand.click();
 }
 for(const text of owned.queueTexts){
  const row=queuedRow(page,text);
  if(await row.count()>1)throw Error('本轮排队消息不唯一，未删除');
  if(await row.count())await row.getByRole('button',{name:'删除排队消息',exact:true}).click();
 }
 for(const name of owned.attachments){
  const row=attachmentRow(page,name);
  if(await row.count()>1)throw Error('本轮附件不唯一，未移除');
  if(await row.count())await row.locator('button[title]').click();
 }
 if(owned.restorePermission){
  const consent=page.getByRole('dialog').filter({visible:true}).filter({has:page.getByRole('heading',{name:'确认开启完全访问权限',exact:true})});
  if(await consent.count()===1)await consent.getByRole('button',{name:'取消',exact:true}).click();
  await resetComposerPermission(page,config);
 }
 await restoreSystemStorageMetadata(page,owned,{checkpoint:config.checkpoint});
 if(owned.workspaceResources)await releaseWorkspaceResources(page,owned.workspaceResources,config);
 await releaseSystemStorage(page,owned,config);
 await releaseInvalidDirectory(owned);
 delete owned.workspaceResources;
}
