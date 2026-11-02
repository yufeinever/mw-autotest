import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {releaseManagedSkills} from './mobilework-module-resources.mjs';

test('技能导入未确认终态时保留上传弹层及目录归属',async()=>{
 const owned={pending:true,pendingKind:'import',pickerToken:'test-token',importFolder:'test-folder'};
 const page=new Proxy({url:()=> 'http://local/#/session'},{get(target,key){if(key==='url')return target.url;throw Error('不应操作页面');}});
 await assert.rejects(()=>releaseManagedSkills(page,owned),/尚未确认终态/);
 assert.equal(owned.pickerToken,'test-token');
 assert.equal(owned.importFolder,'test-folder');
});

test('技能页面文档归属变化时保留上传弹层',async()=>{
 const owned={pending:false,pendingKind:'import',pickerToken:'test-token',importFolder:'test-folder'};
 const page={url:()=> 'http://local/#/experts/skills',locator:()=>({getAttribute:async()=>null})};
 await assert.rejects(()=>releaseManagedSkills(page,owned),/页面或文档归属已变化/);
 assert.equal(owned.pickerToken,'test-token');
});

test('技能导入完成后先保存终态再移除本轮技能',async t=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mw-skill-recovery-'));
 t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const marker='MW-AUTOTEST-093-test',source='name: mw-autotest-import-test\n'+marker;
 await fs.writeFile(path.join(folder,'SKILL.md'),source);
 const owned={projectDir:folder,installedBefore:[],ids:['mw-autotest-import-test','mw-autotest-created-test'],marker,pending:true,pendingKind:'import',pickerToken:'test-token',importFolder:folder};
 let installed=true,checkpointed=false;
 const hidden={filter(){return this;},count:async()=>0,waitFor:async()=>{throw Object.assign(Error('hidden'),{name:'TimeoutError'});}};
 const page={url:()=> 'http://local/#/experts/skills',locator:()=>({getAttribute:async()=>owned.pickerToken}),getByRole:()=>hidden,evaluate:async(fn)=>{
  const call=String(fn);
  if(call.includes('engine:listSkills'))return {skills:installed?[owned.ids[0]]:[]};
  if(call.includes('readLocalSkill'))return {content:source};
  if(call.includes('engine:removeSkill')){assert.equal(checkpointed,true);installed=false;return {ok:true};}
  throw Error('unexpected call');
 }};
 await releaseManagedSkills(page,owned,{checkpoint:async()=>{assert.equal(owned.pending,false);checkpointed=true;}});
 assert.equal(installed,false);assert.equal(owned.pickerToken,undefined);
});
