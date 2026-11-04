import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {editionProfiles,normalizeEdition} from './client-edition.mjs';

export const environmentRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function resolveEnvironment({root=environmentRoot,homeDir=os.homedir(),env=process.env,config={},exists=fs.existsSync,edition=env.MW_CLIENT_EDITION||'enterprise'}={}){
 edition=normalizeEdition(edition);const profile=editionProfiles[edition];
 // Legacy unscoped paths belong to enterprise; never silently reuse them for public.
 config={...(edition==='enterprise'?config:{}),...config.editions?.[edition]};
 const absolute=value=>path.resolve(root,value);
 const local=env.LOCALAPPDATA||path.join(homeDir,'AppData','Local');
 const installs=[{directory:profile.directory,executable:profile.executable||'MobileWork.exe'},...(profile.legacyInstalls||[])];
 const bases=[path.join(local,'Programs'),...[env.ProgramFiles,env['ProgramFiles(x86)']].filter(Boolean)];
 const candidates=installs.flatMap(install=>bases.map(base=>path.join(base,install.directory,install.executable)));
 const clientExecutable=absolute(env.MW_CLIENT_EXECUTABLE||config.clientExecutable||candidates.find(exists)||candidates[0]);
 const clientHome=absolute(env.MW_CLIENT_HOME||config.clientHome||path.join(homeDir,profile.home));
 return {root,edition,clientExecutable,buildInfoPath:path.join(path.dirname(clientExecutable),'resources','build-info.json'),clientHome,
  skillsRoot:absolute(env.MW_SKILLS_ROOT||config.skillsRoot||path.join(clientHome,'xdg','config','opencode','skills')),
  taskRoot:absolute(env.MW_TASK_ROOT||config.taskRoot||path.join(homeDir,'MobileWork')),
  discoveryPath:path.join(clientHome,'electron','openwork-ui-control.json'),
  browserExecutable:env.MW_BROWSER_EXECUTABLE||config.browserExecutable?absolute(env.MW_BROWSER_EXECUTABLE||config.browserExecutable):null};
}
export function readEnvironment(edition=process.env.MW_CLIENT_EDITION||'enterprise'){
 const file=process.env.MW_TEST_ENV_FILE||path.join(environmentRoot,'config','environment.json');
 let config={};
 try{config=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('环境配置读取失败：'+file+'；'+e.message);}
 for(const key of ['clientExecutable','clientHome','skillsRoot','taskRoot','browserExecutable'])if(config[key]!=null&&typeof config[key]!=='string')throw Error('环境配置 '+key+' 必须是路径字符串');
 return resolveEnvironment({config,edition});
}
export const testEnvironment=readEnvironment();
export const previewBrowserOptions=()=>testEnvironment.browserExecutable?{executablePath:testEnvironment.browserExecutable,headless:true}:{channel:'chrome',headless:true};
