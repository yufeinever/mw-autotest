import {execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {promisify} from 'node:util';
import {readEnvironment} from './environment.mjs';
import {probeCdp} from './cdp-readiness.mjs';

const exec=promisify(execFile);

// Only consider a debug port advertised by a child of the installed client
// and actually owned by its unique main process.
export async function discoverClientCdpPort({clientEdition='enterprise'}={}){
 if(process.platform!=='win32')return null;
 const executable=readEnvironment(clientEdition).clientExecutable.replaceAll("'","''");
 const script=`$items=@(Get-CimInstance Win32_Process -Filter "Name='MobileWork.exe'" | Where-Object { $_.ExecutablePath -eq '${executable}' });
 $main=@($items | Where-Object { $_.CommandLine -notmatch '--type=' });
 $ports=@();
 if($main.Count -eq 1){
  $id=$main[0].ProcessId;
  $listeners=@(Get-NetTCPConnection -OwningProcess $id -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' } | ForEach-Object { [int]$_.LocalPort });
  $ports=@($items | Where-Object { $_.ParentProcessId -eq $id } | ForEach-Object { if($_.CommandLine -match '--remote-debugging-port=(\\d+)'){ [int]$matches[1] } } | Where-Object { $_ -in $listeners } | Select-Object -Unique);
 }
 [pscustomobject]@{mainCount=$main.Count; ports=@($ports)} | ConvertTo-Json -Compress`;
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000});
 const result=JSON.parse(stdout.trim());
 if(result.mainCount>1)throw Error('存在多个 MobileWork 主进程，无法自动识别调试端口');
 const ports=[...new Set((result.ports||[]).map(Number).filter(port=>Number.isInteger(port)&&port>0&&port<=65535))];
 const connected=[];
 for(const port of ports){const state=await probeCdp(port,{clientEdition});if(state.connected)connected.push(state);}
 if(connected.length>1)throw Error('发现多个有效的 MobileWork 调试端口，无法自动选择');
 return connected[0]||null;
}

async function availablePort(port){
 return new Promise((resolve,reject)=>{
  const server=createServer();
  server.once('error',error=>{
   if(['EADDRINUSE','EACCES'].includes(error.code))resolve(null);
   else reject(error);
  });
  server.listen({host:'127.0.0.1',port,exclusive:true},()=>{
   const selected=server.address().port;
   server.close(error=>error?reject(error):resolve(selected));
  });
 });
}

export async function selectAvailableCdpPort(preferred){
 if(!Number.isInteger(preferred)||preferred<1||preferred>65535)throw Error('CDP端口无效');
 for(const port of [...new Set([preferred,19223,0])]){
  const selected=await availablePort(port);if(selected)return selected;
 }
 throw Error('无法找到可用的本机 CDP 端口');
}
