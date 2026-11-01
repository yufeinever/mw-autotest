import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {workspaces,prepareWorkspaceResources} from './mobilework-workspaces.mjs';
import {validateSystemStorage} from './mobilework-default-storage.mjs';
const exec=promisify(execFile),helper=fileURLToPath(new URL('mobilework-invalid-directory.ps1',import.meta.url));
export async function invalidDirectory(action,folder,sddl){const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',helper,'-Action',action,'-Path',folder,...(sddl?['-Sddl',sddl]:[])],{windowsHide:true,encoding:'utf8'});return JSON.parse(stdout);}
export function validateInvalidDirectory(value,previous){
 if(!/^[a-f0-9-]{36}$/.test(value.owner)||!path.isAbsolute(value.path)||path.basename(value.path)!=='MW-AUTOTEST-DENY-'+value.owner||typeof value.sddl!=='string'||!value.sddl||Object.keys(value).some(key=>!['owner','path','sddl'].includes(key)))throw Error('本轮拒写目录归属无效');
 if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw Error('不能替换本轮拒写目录基线');
}
export async function prepareInvalidDirectory(context){const owner=randomUUID(),folder=path.join(context.dir,'MW-AUTOTEST-DENY-'+owner),created=await invalidDirectory('Create',folder),owned={owner,path:folder,sddl:created.sddl};validateInvalidDirectory(owned);context.resources.invalidDirectory=owned;await context.checkpointResources();await invalidDirectory('Deny',folder);return owned;}
export async function releaseInvalidDirectory(resources,{operate=invalidDirectory}={}){const owned=resources.invalidDirectory;if(!owned)return;validateInvalidDirectory(owned);await operate('Restore',owned.path,owned.sddl);delete resources.invalidDirectory;}
export async function prepareStorageProbe(context,targetPath){
 const {items}=await workspaces(context.page),defaults=items.filter(item=>item.isDefault);if(defaults.length!==1)throw Object.assign(Error('未确认唯一原默认空间'),{blocked:true});
 const {id,name,path:folder}=defaults[0],oldScratch=await context.page.evaluate(()=>JSON.parse(localStorage.getItem('openwork.preferences')).scratchFolderPath??null);
 const owned={owner:randomUUID(),originUrl:context.page.url(),originalDefault:{id,name,path:folder},targetPath,oldScratch,stage:'prepared'};validateSystemStorage(owned);context.resources.systemStorage=owned;context.resources.workspaceResources=await prepareWorkspaceResources(context.page,{target:{name:'默认工作空间',path:targetPath}});await context.checkpointResources();return owned;
}
