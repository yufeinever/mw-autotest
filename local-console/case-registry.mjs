import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {clientCases} from '../scripts/client-case-catalog.mjs';
import {permissionCases} from '../scripts/permission-case-catalog.mjs';

// 只补充缺失入口，保留原ID、顺序、用户命名和其他自定义脚本。
export function withClientCases(existing,root){
 const result=existing.map(item=>({...item,suite:item.suite==='permission'?'permission':'functional'}));
 const key=file=>path.resolve(file).toLowerCase();
 const paths=new Set(result.map(s=>key(s.path)));
 for(const item of [...clientCases,...permissionCases]){
  const file=path.join(root,item.entry);
  const known={suite:item.suite||'functional',caseId:item.id,unavailable:item.unavailable||''};
  if(paths.has(key(file))){Object.assign(result.find(s=>key(s.path)===key(file)),known);continue;}
  result.push({id:randomUUID(),name:String(item.number).padStart(2,'0')+' · '+item.button,path:file,...known});paths.add(key(file));
 }
 return result;
}
