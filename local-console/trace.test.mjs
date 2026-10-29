import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildTrace,renderTrace} from './trace.mjs';
import {loadJobTrace} from './trace-store.mjs';
import {saveRunTrace} from '../scripts/mobilework-trace.mjs';
import {createConsole} from './server.mjs';

const tool=(name='github',status='completed')=>({id:'part1',type:'tool',tool:'skill',callID:'call1',state:{status,input:{name},output:`<skill_content name="${name}">\n# Skill: ${name}\n</skill_content>`,metadata:{name},time:{start:1792322183839,end:1792322183898}}});
const snapshot=(parts=[tool()],id='ses_root',parent)=>({sessionId:id,session:{id,parentID:parent,time:{created:1792322180000}},messages:[{info:{id:'msg1',sessionID:id,role:'assistant',time:{created:1792322180000}},parts}],childrenCollected:true,exportedAt:'2026-10-18T11:16:30Z'});
test('Skill 只接受精确 ID 的成功工具加载；提及、路径、错误或伪结果均失败',()=>{
 const good=buildTrace(snapshot(),{expectedSkills:['github']});assert.equal(good.checks[0].pass,true);assert.equal(good.events[0].durationMs,59);
 const cases=[snapshot([{type:'text',text:'已调用 github，路径 skills/github/SKILL.md'}]),snapshot([{...tool(),tool:'read'}]),snapshot([tool('github-other')]),snapshot([tool('github','error')]),snapshot([tool('github','running')]),snapshot([{...tool(),state:{...tool().state,output:'Skill not found'}}]),snapshot([{...tool(),state:{...tool().state,metadata:{name:'other'}}}])];
 for(const input of cases)assert.equal(buildTrace(input,{expectedSkills:['github']}).checks[0].pass,false);
 const input=snapshot();input.messages[0].info.role='user';assert.equal(buildTrace(input,{expectedSkills:['github']}).checks[0].pass,false);
 const multi=buildTrace(snapshot(),{expectedSkills:['github','email-official']});assert.deepEqual(multi.checks.map(c=>c.pass),[true,false]);
 assert.equal(buildTrace(snapshot([tool(),tool('github','error')]),{expectedSkills:['github']}).checks[0].pass,false);
 assert.equal(buildTrace(snapshot(),{expectedSkills:[]}).checks.length,0);
});
test('Trace 只跟踪可证父子关系及消息归属，保留错误与时间线',()=>{
 const root=snapshot([]);root.children=[snapshot([tool()],'ses_child','ses_root'),snapshot([tool('other')],'ses_foreign','ses_unknown')];
 const result=buildTrace(root,{expectedSkills:['github','other']});assert.deepEqual(result.checks.map(c=>c.pass),[true,false]);assert.equal(result.summary.sessions,2);assert.ok(result.warnings.length);
 const wrong=snapshot();wrong.messages[0].info.sessionID='ses_other';assert.equal(buildTrace(wrong,{expectedSkills:['github']}).checks[0].pass,false);
 const wrongPart=snapshot([{...tool(),sessionID:'ses_other'}]);assert.equal(buildTrace(wrongPart,{expectedSkills:['github']}).checks[0].pass,false);
 const errors=snapshot([tool('github','error')]);errors.messages[0].info.error={name:'APIError',message:'boom'};assert.equal(buildTrace(errors).summary.toolErrors,1);
});
test('Trace 页面转义工具内容，JSON 和 HTML 均脱敏',()=>{
 const part=tool();part.state.input.apiKey='private';part.state.output='<script>alert(1)</script> sk-12345678901234';
 const result=buildTrace(snapshot([part]),{expectedSkills:['github']});const html=renderTrace({id:'job1',name:'<img src=x>'},result);
 assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!html.includes('sk-12345678901234'));assert.ok(!html.includes('<script>'));assert.match(html,/result-fail/);assert.match(html,/下载 Trace JSON/);
});
test('历史 Trace 单独审计不改结论，离线可读取落盘快照，阻塞仍支持回读',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-trace-'));
 const job={id:'j1',status:'PASS',path:'D:/scripts/run-client-case006.mjs',reportPath:path.join(dir,'执行报告.md'),result:{caseId:'MW-CLIENT-006',sessionId:'ses_root',checks:[]}};
 await fs.writeFile(path.join(dir,'ses_root-session-log.json'),JSON.stringify(snapshot()));
 const original=JSON.stringify(job),trace=await loadJobTrace(job,()=>{throw Error('不应连接客户端');});assert.equal(trace.checks[0].pass,true);assert.equal(JSON.stringify(job),original);assert.equal(trace.origin,'saved-session');
 await assert.rejects(()=>loadJobTrace({status:'BLOCKED'},()=>{}),/会话 ID/);
 const failed={...job,status:'FAIL',reportPath:null};assert.equal((await loadJobTrace(failed,async()=>snapshot())).checks[0].pass,true);
 await assert.rejects(()=>loadJobTrace(failed,async()=>snapshot([],'ses_wrong')),/ID/);
});
test('执行器统一保存 Trace 并将缺少调用加入失败断言；前16条均接入',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-trace-run-')),checks=[];
 const page={evaluate:async(fn,arg)=>{assert.equal(arg.includeChildren,true);return snapshot([]);}};
 const result=await saveRunTrace({page,sessionId:'ses_root',number:6,dir,checks});assert.equal(result.path,'trace.json');assert.equal(checks[0].pass,false);assert.equal(JSON.parse(await fs.readFile(path.join(dir,'trace.json'))).checks[0].pass,false);
 const failedChecks=[];await saveRunTrace({page:{evaluate:async()=>{throw Error('无法连接');}},sessionId:'ses_root',number:6,dir,checks:failedChecks});assert.equal(failedChecks[0].pass,false);
 const mismatched=[];await saveRunTrace({page:{evaluate:async()=>snapshot([tool()],'ses_foreign')},sessionId:'ses_root',number:6,dir,checks:mismatched});assert.equal(mismatched[0].pass,false);assert.match(mismatched[0].actual,/本次执行不一致/);
 for(const entry of ['../scripts/run-client-case001.mjs','../scripts/run-client-case002.mjs','../scripts/client-case-runner.mjs']){const text=await fs.readFile(new URL(entry,import.meta.url),'utf8');assert.match(text,/await saveRunTrace/);assert.match(text,/checks\.some\(c=>!c\.pass\)/);}
});
test('Trace HTTP 入口支持失败、阻塞、下载及无ID说明，且不修改历史断言',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-trace-http-'));
 for(const [id,status,sessionId] of [['failed','FAIL','ses_root'],['blocked','BLOCKED','ses_root'],['missing','BLOCKED',null]]){
  await fs.mkdir(path.join(dir,'jobs',id),{recursive:true});await fs.writeFile(path.join(dir,'jobs',id,'job.json'),JSON.stringify({id,name:id,status,startedAt:'2026-10-18T00:00:00Z',result:{caseId:'MW-CLIENT-006',sessionId,checks:[{name:'原断言',pass:false}]}}));
 }
 const {server,url}=await createConsole({clientProbe:async()=>({connected:true}),port:0,dataDir:dir,traceReader:async()=>snapshot([tool('github','error')])});
 try{
  for(const id of ['failed','blocked']){
   const html=await(await fetch(url+'/traces/'+id)).text();assert.match(html,/Trace 记录/);assert.match(html,/result-fail/);
   const download=await fetch(url+'/traces/'+id+'/download');assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/attachment/);assert.equal((await download.json()).checks[0].pass,false);
   const job=await(await fetch(url+'/api/jobs/'+id)).json();assert.equal(job.result.checks.length,1);
  }
  assert.match(await(await fetch(url+'/traces/missing')).text(),/没有取得会话 ID/);assert.equal((await fetch(url+'/traces/missing/download')).status,400);
  assert.equal((await fetch(url+'/traces/nonexistent')).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
