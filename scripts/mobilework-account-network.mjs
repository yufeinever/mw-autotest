import {execFile as runFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const execFile=promisify(runFile),helper=fileURLToPath(new URL('mobilework-account-network.ps1',import.meta.url));
const blocked=message=>Object.assign(Error(message),{blocked:true});
export async function accountNetworkCommand(mode,owned={}){
 const args=['-NoProfile','-NonInteractive','-File',helper,'-Mode',mode,...(owned.pid?['-ClientPid',String(owned.pid)]:[])];
 if(mode!=='process')args.push('-RuleName',owned.name,'-Program',owned.program,'-Addresses',owned.addresses.join(','),'-RemotePort',String(owned.port));
 const {stdout}=await execFile('powershell.exe',args,{windowsHide:true,encoding:'utf8'});return JSON.parse(stdout.replace(/^\uFEFF/,''));
}
export function validateAccountNetwork(value,previous){
 if(!/^MW-Autotest-Network-169-[a-f0-9-]{36}$/.test(value.name)||!Number.isInteger(value.pid)||value.pid<=0||typeof value.program!=='string'||!path.win32.isAbsolute(value.program)||!/[\\/]MobileWork\.exe$/i.test(value.program)||!Array.isArray(value.addresses)||!value.addresses.length||value.addresses.some(address=>!isIP(address))||!Number.isInteger(value.port)||value.port<1||value.port>65535||Object.keys(value).some(key=>!['name','pid','program','addresses','port'].includes(key)))throw Error('本轮账户网络故障归属无效');
 if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw Error('不能替换本轮网络故障范围');
}
export async function applyAccountNetworkFault(context){
 const cdp=await context.page.context().browser().newBrowserCDPSession();let pid;
 try{pid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(process=>process.type==='browser')?.id;}finally{await cdp.detach();}
 if(!Number.isInteger(pid))throw blocked('无法确认客户端主进程，未改变网络');
 const process=await accountNetworkCommand('process',{pid});if(!process.administrator)throw blocked('169需要管理员权限创建仅限客户端门户地址的临时规则；未全局断网');
 const portal=await context.page.evaluate(async()=>{const {portal}=await (window.__MOBILEWORK_ELECTRON__ ?? window.__OPENWORK_ELECTRON__).invokeDesktop('runtimeEndpoints');return portal;});
 const url=new URL(portal);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw blocked('未取得有效门户地址，未改变网络');
 const addresses=[...new Set((await lookup(url.hostname,{all:true})).map(item=>item.address))].sort();
 const owned={name:'MW-Autotest-Network-169-'+randomUUID(),pid,program:process.program,addresses,port:Number(url.port)||(url.protocol==='https:'?443:80)};
 validateAccountNetwork(owned);context.resources.accountNetwork=owned;await context.checkpointResources();
 await accountNetworkCommand('apply',owned);return owned;
}
export async function releaseAccountNetwork(resources,{command=accountNetworkCommand}={}){
 if(!resources.accountNetwork)return;const owned=resources.accountNetwork;validateAccountNetwork(owned);
 const result=await command('remove',owned);if(result.exists)throw blocked('本轮客户端网络规则仍存在，未放行下一条');delete resources.accountNetwork;
}
