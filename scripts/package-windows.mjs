import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import {unzipSync,strFromU8} from 'fflate';
import {clientCases,caseWorkbook} from './client-case-catalog.mjs';
import {permissionCases} from './permission-case-catalog.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=b=>createHash('sha256').update(b).digest('hex');
const psQuote=s=>"'"+s.replaceAll("'","''")+"'";
async function run(command,args,options={}){
 await new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:root,stdio:'inherit',windowsHide:true,...options});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(command+' 退出码 '+code)));});
}
async function filesUnder(dir){
 const result=[];for(const item of await fs.readdir(dir,{withFileTypes:true})){
  if(item.name==='.links')continue;const file=path.join(dir,item.name);
  if(item.isSymbolicLink())throw Error('不打包符号链接：'+file);
  if(item.isDirectory())result.push(...await filesUnder(file));else result.push(file);
 }return result.sort();
}
export async function selectedFiles(){
 const selected=['README.md','AGENTS.md','需求文档.md','版本迭代说明.md','打包与迁移说明.md','启动测试平台.cmd','环境检查.cmd','package.json','package-lock.json','config/environment.json'];
 for(const name of await fs.readdir(path.join(root,'需求文档')))if(/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.md$/.test(name))selected.push('需求文档/'+name);
 for(const name of await fs.readdir(path.join(root,'操作指引/桌面工作台')))if(name.endsWith('.md'))selected.push('操作指引/桌面工作台/'+name);
 for(const item of await fs.readdir(path.join(root,'local-console'),{withFileTypes:true}))if(item.isFile()&&/\.(?:mjs|js|html|css|md)$/.test(item.name))selected.push('local-console/'+item.name);
 selected.push('local-console/fixtures/long-running.mjs','scripts/fixtures/case002-synthetic-meeting.mjs');
 selected.push(...clientCases.map(c=>c.entry));
 selected.push(...permissionCases.map(c=>c.entry));
 selected.push(...['permission-case-catalog.mjs','permission-case-runner.mjs','permission-fixtures.mjs','permission-observation.mjs','permission-workspace.mjs','permission-suite.test.mjs'].map(s=>'scripts/'+s));
 selected.push('scripts/mobilework-initialize.mjs','scripts/mobilework-initialize.test.mjs');
 for(const name of await fs.readdir(path.join(root,'scripts/fixtures/client-upload-files')))selected.push('scripts/fixtures/client-upload-files/'+name);
 selected.push('scripts/client-interaction-case-runner.mjs','scripts/mobilework-composer-resources.mjs','scripts/client-home-workspace-steps.mjs','scripts/client-home-model-steps.mjs');
 selected.push('scripts/client-task-lifecycle-steps.mjs','scripts/mobilework-task-ui.mjs','scripts/mobilework-explorer-folder.py');
 selected.push('scripts/client-message-display-steps.mjs','scripts/mobilework-attachment-ui.mjs');
 selected.push('scripts/client-message-actions-steps.mjs','scripts/mobilework-message-clipboard.mjs','scripts/mobilework-message-queue.mjs');
 selected.push('scripts/client-queue-workbench-steps.mjs');
 selected.push('scripts/client-file-preview-steps.mjs');
 selected.push('scripts/client-office-file-steps.mjs','scripts/fixtures/prepare-office-preview.py');
 selected.push('scripts/client-browser-workspace-steps.mjs','scripts/mobilework-workspaces.mjs');
 selected.push('scripts/client-workspace-management-steps.mjs','scripts/client-rpa-preconditions.mjs','scripts/mobilework-module-navigation.mjs','scripts/mobilework-module-handoff.mjs');
 selected.push('scripts/client-staff-market-steps.mjs','scripts/mobilework-staff-market.mjs','scripts/client-gui-recording-steps.mjs');
 selected.push('scripts/client-knowledge-management-steps.mjs','scripts/client-knowledge-list-steps.mjs','scripts/mobilework-knowledge-resources.mjs','scripts/mobilework-knowledge-guide.mjs');
 selected.push("scripts/client-security-settings-steps.mjs","scripts/client-conversation-settings-steps.mjs","scripts/mobilework-conversation-settings.mjs","scripts/mobilework-prompt-observation.mjs","scripts/mobilework-conversation-settings.test.mjs");
 selected.push("scripts/client-system-memory-steps.mjs","scripts/mobilework-window-close.mjs","scripts/mobilework-window-state.py","scripts/mobilework-storage-probe.mjs","scripts/mobilework-invalid-directory.ps1","scripts/mobilework-account-memory.mjs","scripts/mobilework-system-memory.test.mjs");
 selected.push('scripts/client-system-settings-steps.mjs','scripts/mobilework-system-settings.mjs','scripts/mobilework-system-theme.ps1','scripts/mobilework-default-storage.mjs','scripts/mobilework-client-restart.mjs','scripts/mobilework-system-settings.test.mjs');
 selected.push('scripts/client-account-profile-steps.mjs','scripts/mobilework-account-settings.mjs','scripts/mobilework-account-logout.mjs','scripts/mobilework-account-profile.test.mjs');
 selected.push('scripts/client-account-navigation-steps.mjs','scripts/mobilework-account-network.mjs','scripts/mobilework-account-network.ps1','scripts/mobilework-account-external.mjs','scripts/mobilework-account-observation.mjs','scripts/mobilework-account-navigation.test.mjs');
 selected.push('scripts/client-help-feedback-steps.mjs','scripts/mobilework-help-external.mjs');
 selected.push('scripts/client-feedback-steps.mjs','scripts/mobilework-feedback-external.mjs','scripts/client-update-steps.mjs','scripts/mobilework-update-observation.mjs');
 selected.push('scripts/client-efficiency-steps.mjs','scripts/mobilework-efficiency.mjs','scripts/mobilework-disk-observation.ps1','scripts/fixtures/efficiency/disk-scan-reference.py','scripts/mobilework-account-menu.mjs','scripts/client-account-usage-steps.mjs','scripts/mobilework-efficiency-account.test.mjs');
 selected.push('scripts/client-mail-workflow-steps.mjs','scripts/mobilework-mail-operations.mjs','scripts/client-weather-steps.mjs','scripts/mobilework-weather-baseline.mjs');
 selected.push('scripts/client-kanban-task-steps.mjs','scripts/client-kanban-operations-steps.mjs','scripts/mobilework-kanban-operation-resources.mjs','scripts/client-mail-dashboard-steps.mjs','scripts/mobilework-mail-baseline.mjs');
 selected.push('scripts/mobilework-knowledge-settings.mjs','scripts/client-knowledge-settings-steps.mjs','scripts/mobilework-kanban.mjs','scripts/client-kanban-steps.mjs');
 selected.push('scripts/mobilework-knowledge-graph-settings.mjs','scripts/client-knowledge-graph-settings-steps.mjs');
 selected.push('scripts/mobilework-knowledge-reading.mjs','scripts/client-knowledge-reading-steps.mjs');
 selected.push('scripts/mobilework-knowledge-ingest.mjs','scripts/client-knowledge-ingest-steps.mjs');
 selected.push('scripts/mobilework-knowledge-create.mjs','scripts/mobilework-knowledge-parse.mjs','scripts/mobilework-knowledge-source-ui.mjs','scripts/client-knowledge-source-steps.mjs');
 selected.push('scripts/client-case-library-task-steps.mjs');
 selected.push('scripts/mobilework-root-session-group.mjs','scripts/client-case-multi-root-steps.mjs');
 selected.push('scripts/client-case-library-steps.mjs','scripts/mobilework-case-library.mjs');
 selected.push('scripts/client-automation-steps.mjs','scripts/mobilework-automation-resources.mjs');
 selected.push('scripts/client-expert-module-steps.mjs','scripts/mobilework-module-resources.mjs');
 selected.push('scripts/client-recording-workflow-steps.mjs','scripts/mobilework-recording-expert.mjs','scripts/client-skill-management-steps.mjs','scripts/mobilework-market-ui.mjs');
 selected.push('scripts/client-mindmap-todo-steps.mjs','scripts/mobilework-todo-ui.mjs','scripts/mobilework-explorer.mjs','scripts/mobilework-xmind-installation.ps1');
 for(const file of await filesUnder(path.join(root,'scripts/fixtures/mindmap')))selected.push(path.relative(root,file).replaceAll('\\','/'));
 for(const file of await filesUnder(path.join(root,'scripts/fixtures/office-preview')))selected.push(path.relative(root,file).replaceAll('\\','/'));
 selected.push('scripts/client-loading-usage-steps.mjs','scripts/mobilework-personalization.mjs','scripts/mobilework-message-observer.mjs','scripts/fixtures/loading-greetings.json');
 selected.push('scripts/client-ui-case-runner.mjs','scripts/client-config-case-runner.mjs','scripts/mobilework-folder-picker.py','scripts/mobilework-native-folder.mjs','scripts/mobilework-knowledge-case.mjs','scripts/mobilework-knowledge-api.mjs','scripts/mobilework-expert-resources.mjs','scripts/mobilework-tool-resources.mjs','scripts/mobilework-skill-resources.mjs');
 selected.push('scripts/mobilework-permission-events.mjs','scripts/mobilework-permission-recovery.test.mjs');
 selected.push('scripts/mobilework-model-selection.test.mjs');
 selected.push('scripts/mobilework-task-control.mjs','scripts/mobilework-task-control.test.mjs','scripts/mobilework-question-no-send.test.mjs','scripts/mobilework-isolation.mjs','scripts/mobilework-standalone.mjs','scripts/mobilework-isolation.test.mjs','scripts/mobilework-full-access.test.mjs');
 selected.push(...['client-case-catalog.mjs','client-case-inputs.mjs','client-case-runner.mjs','client-case-checks.mjs','client-case-preview.mjs','client-cases.test.mjs','mobilework-run-policy.mjs','mobilework-run-policy.test.mjs','mobilework-composer.mjs','mobilework-evidence.mjs','mobilework-trace.mjs','case002-meeting-data.mjs','case002-meeting.test.mjs','build-console-app.mjs','node-runner.cmd','check-package.mjs','package-windows.mjs'].map(s=>'scripts/'+s));
 for(const name of await fs.readdir(path.join(root,'测试用例与脚本')))if(/\.(?:md|cmd)$/.test(name)||name===caseWorkbook||name==='客户端多端兼容-覆盖清单.json')selected.push('测试用例与脚本/'+name);
 return [...new Set(selected)].sort();
}
export async function validateSources(files){
 const set=new Set(files.map(f=>path.resolve(root,f).toLowerCase()));
 for(const rel of files){
  const file=path.join(root,rel),buffer=await fs.readFile(file);
  const text=rel.endsWith('.xlsx')?Object.entries(unzipSync(buffer)).filter(([name])=>name.endsWith('.xml')).map(([,bytes])=>strFromU8(bytes)).join('\n'):buffer.toString('utf8');
  if(/\b(?:sk-|ghp_|cfat_)[A-Za-z0-9_-]{32,}/.test(text))throw Error('发现疑似凭证，停止发布（不输出值）：'+rel);
  if(/\.(?:mjs|js)$/.test(rel)){
   const imports=[...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"\n]+)['"]/g)].map(m=>m[1]);
   for(const specifier of imports)if(!set.has(path.resolve(path.dirname(file),specifier).toLowerCase()))throw Error('遗漏本地依赖：'+rel+' → '+specifier);
  }
 }
}
async function normalizeCmd(file){const text=await fs.readFile(file,'utf8');await fs.writeFile(file,text.replace(/\r?\n/g,'\r\n'));}
async function stageSources(target,files){
 for(const rel of files){const dst=path.join(target,rel);await fs.mkdir(path.dirname(dst),{recursive:true});await fs.copyFile(path.join(root,rel),dst);if(rel.endsWith('.cmd'))await normalizeCmd(dst);}
 const pkg=JSON.parse(await fs.readFile(path.join(target,'package.json'),'utf8'));
 pkg.description='MobileWork 功能与权限行为用例、本地测试控制台及自动化脚本';
 pkg.scripts={'build:console':'node scripts/build-console-app.mjs','start':'node local-console/launch.mjs','check':'node scripts/check-package.mjs','check:package':'node scripts/check-package.mjs --self-test','package:windows':'node scripts/package-windows.mjs',test:'node --test --test-concurrency=1 scripts/client-cases.test.mjs scripts/mobilework-run-policy.test.mjs scripts/case002-meeting.test.mjs local-console/console.test.mjs local-console/batches.test.mjs local-console/trace.test.mjs local-console/session-log.test.mjs local-console/cdp-config.test.mjs local-console/cdp-restart.test.mjs local-console/stop-job.test.mjs local-console/environment.test.mjs'};
 pkg.scripts.test+=' local-console/task-scheduler.test.mjs scripts/mobilework-task-control.test.mjs';
 pkg.scripts['recording:setup']='node node_modules/ffmpeg-static/install.js';
 await fs.writeFile(path.join(target,'package.json'),JSON.stringify(pkg,null,2)+'\n');
 // Never copy local runtime configuration or client account data.
 await fs.writeFile(path.join(target,'config','environment.json'),JSON.stringify({clientExecutable:'',clientHome:'',skillsRoot:'',taskRoot:'',browserExecutable:''},null,2)+'\n');
 await fs.writeFile(path.join(target,'.gitignore'),'node_modules/\nruntime/\nruns/\nruntime-config/\ndist/\nconfig/environment.local.json\n');
}
async function seal(target,kind,baseline){
 const all=await filesUnder(target),records=[];
 for(const file of all){const data=await fs.readFile(file);records.push({path:path.relative(target,file).replaceAll('\\','/'),bytes:data.length,sha256:hash(data)});}
 const manifest={format:'mobilework-test-release',version:1,kind,createdAt:new Date().toISOString(),platform:'win32',architecture:'x64',node:process.version,playwright:'1.62.1',browser:kind==='portable'?'chromium-headless-shell revision 1234':null,caseCount:clientCases.length,sheet:'测试案例（客户端-多端兼容）',containsHistoricalRuns:false,containsClientOrCredentials:false,baseline,files:records};
 await fs.writeFile(path.join(target,'发布清单.json'),JSON.stringify(manifest,null,2)+'\n');
 const manifestBytes=await fs.readFile(path.join(target,'发布清单.json'));
 await fs.writeFile(path.join(target,'SHA256SUMS.txt'),records.map(r=>r.sha256+'  '+r.path).join('\n')+'\n'+hash(manifestBytes)+'  发布清单.json\n');
}
async function zip(target,destination){
 await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(target)},${psQuote(destination)},[IO.Compression.CompressionLevel]::Optimal,$true)`]);
}

export async function packageWindows(){
 if(process.platform!=='win32'||process.arch!=='x64')throw Error('当前发布脚本只支持 Windows x64');
 if(!/^v22\./.test(process.version))throw Error('本便携包使用 Node.js 22，请使用该版本打包');
 console.log('构建控制台…');await run(process.execPath,['scripts/build-console-app.mjs']);
 const files=await selectedFiles();await validateSources(files);
 const baseline=[];for(const file of files)baseline.push({path:file,sha256:hash(await fs.readFile(path.join(root,file)))});
 const now=new Date(),stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(now).replaceAll(/[- :]/g,'');
 const parent=path.join(root,'dist','releases');await fs.mkdir(parent,{recursive:true});
 let output;for(let n=1;;n++)try{output=path.join(parent,stamp+'-MobileWork测试平台-第'+String(n).padStart(2,'0')+'次');await fs.mkdir(output);break;}catch(e){if(e.code!=='EEXIST')throw e;}
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'MobileWork-build-'));
 const source=path.join(temp,'MobileWork测试平台-源码'),portable=path.join(temp,'MobileWork测试平台-Windows-x64');
 await stageSources(source,files);await stageSources(portable,files);
 console.log('安装便携包生产依赖…');
 try{await run('cmd.exe',['/d','/c','npm ci --omit=dev --ignore-scripts --no-audit --no-fund --offline'],{cwd:portable});}
 catch{await run('cmd.exe',['/d','/c','npm ci --omit=dev --ignore-scripts --no-audit --no-fund'],{cwd:portable});}
 // npm ci skips install scripts. Include the encoder and upstream notices
 // explicitly so the portable package records without another download.
 if(!ffmpegPath)throw Error('缺少录像编码器，请运行 npm run recording:setup 后打包');
 for(const suffix of ['','.LICENSE','.README']){
  const source=ffmpegPath+suffix;await fs.access(source);
  await fs.copyFile(source,path.join(portable,'node_modules','ffmpeg-static',path.basename(source)));
 }
 await fs.mkdir(path.join(portable,'runtime'),{recursive:true});await fs.copyFile(process.execPath,path.join(portable,'runtime','node.exe'));
 const licenseUrl='https://raw.githubusercontent.com/nodejs/node/'+process.version+'/LICENSE';
 const license=await fetch(licenseUrl,{signal:AbortSignal.timeout(60000)});if(!license.ok)throw Error('下载Node许可证失败 HTTP '+license.status);
 await fs.writeFile(path.join(portable,'runtime','NODE-LICENSE.txt'),await license.text());
 const cache=path.join(root,'runtime-config','package-cache','browsers');
 const shell=path.join(cache,'chromium_headless_shell-1234','chrome-headless-shell-win64','chrome-headless-shell.exe');
 try{await fs.access(shell);}catch{await run(process.execPath,['node_modules/playwright-core/cli.js','install','chromium','--only-shell','--no-progress'],{env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:cache}});}
 console.log('复制内置浏览器与许可…');
 for(const file of await filesUnder(cache)){const dest=path.join(portable,'runtime','browsers',path.relative(cache,file));await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(file,dest);}
 const config=JSON.parse(await fs.readFile(path.join(portable,'config','environment.json'),'utf8'));
 config.browserExecutable=path.relative(cache,shell).replaceAll('\\','/');config.browserExecutable='runtime/browsers/'+config.browserExecutable;
 await fs.writeFile(path.join(portable,'config','environment.json'),JSON.stringify(config,null,2)+'\n');
 await seal(source,'source',baseline);await seal(portable,'portable',baseline);
 const sourceZip=path.join(output,'MobileWork测试平台-源码.zip'),portableZip=path.join(output,'MobileWork测试平台-Windows-x64.zip');
 console.log('生成源码ZIP…');await zip(source,sourceZip);console.log('生成便携ZIP…');await zip(portable,portableZip);
 const release={createdAt:new Date().toISOString(),buildDirectory:temp,files:[]};
 for(const file of [sourceZip,portableZip]){const data=await fs.readFile(file);release.files.push({name:path.basename(file),bytes:data.length,sha256:hash(data)});}
 await fs.writeFile(path.join(output,'交付清单.json'),JSON.stringify(release,null,2)+'\n');
 console.log('发布目录：'+output);console.log('构建暂存：'+temp);return {output,sourceZip,portableZip,temp};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await packageWindows();
