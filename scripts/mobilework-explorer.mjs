import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
const execFile=promisify(execFileCallback);
const helper=fileURLToPath(new URL('./mobilework-explorer-folder.py',import.meta.url));
export async function inspectExplorer(folder,{close,reveal=false}={}){
 const args=[helper,'--path',path.resolve(folder),...(reveal?['--reveal']:[]),...(close?['--close',String(close)]:[])];
 const {stdout}=await execFile(process.env.MW_PYTHON||'python',args,{windowsHide:true,encoding:'utf8'});
 return JSON.parse(stdout);
}
