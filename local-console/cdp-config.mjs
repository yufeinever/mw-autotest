import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {testEnvironment} from './environment.mjs';
export const buildInfoPath=testEnvironment.buildInfoPath;
export async function readCdpConfig(file=buildInfoPath){
 try{const data=JSON.parse(await fs.readFile(file,'utf8'));return {version:data.version||data.productVersion||'未知',allowed:typeof data.packagedCdpAllowed==='boolean'?data.packagedCdpAllowed:null,error:typeof data.packagedCdpAllowed==='boolean'?null:'未找到布尔类型 packagedCdpAllowed'};}
 catch{return {allowed:null,error:'无法读取客户端 build-info.json，请检查安装路径及文件权限'};}
}
export async function enableCdpConfig(backupDir,file=buildInfoPath){
 const original=await fs.readFile(file,'utf8'),data=JSON.parse(original);
 if(typeof data.packagedCdpAllowed!=='boolean')throw Error('packagedCdpAllowed 字段缺失或类型不正确，未修改');
 if(data.packagedCdpAllowed)return {...await readCdpConfig(file),changed:false};
 const matches=[...original.matchAll(/"packagedCdpAllowed"\s*:\s*false/g)];
 if(matches.length!==1)throw Error('CDP 配置字段不唯一，未修改');
 const changed=original.replace(/("packagedCdpAllowed"\s*:\s*)false/,'$1true');
 const expected={...data,packagedCdpAllowed:true};
 if(JSON.stringify(JSON.parse(changed))!==JSON.stringify(expected))throw Error('配置校验失败，未修改');
 await fs.mkdir(backupDir,{recursive:true});
 const backup=path.join(backupDir,'build-info-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.json');
 await fs.writeFile(backup,original,{flag:'wx'});
 if(await fs.readFile(file,'utf8')!==original)throw Error('客户端配置发生变化，请刷新重试');
 await fs.writeFile(file,changed);
 const result=await readCdpConfig(file);if(result.allowed!==true)throw Error('写入后核对失败，备份位置：'+backup);
 return {...result,changed:true,backup};
}
