import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareKnowledgeFormats,rawKnowledgeName,assessKnowledgeProgress} from './mobilework-knowledge-ingest.mjs';

test('知识解析材料包含真实legacy二进制且各格式raw名称互不覆盖',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-kb-formats-'));
 const inputs=await prepareKnowledgeFormats(dir);
 assert.deepEqual(inputs.map(item=>item.format),['doc','docx','ppt','pptx','xls','xlsx','pdf','md']);
 assert.equal(new Set(inputs.map(item=>rawKnowledgeName(item.path))).size,8);
 for(const input of inputs){
  const bytes=await fs.readFile(input.path);
  if(['doc','xls','ppt'].includes(input.format))assert.equal(bytes.subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1');
  else if(input.format.endsWith('x'))assert.equal(bytes.subarray(0,2).toString(),'PK');
  else if(input.format==='pdf')assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
  else assert.ok(bytes.toString('utf8').includes('7319'));
 }
});
const sample=(at,stage,message,extras={})=>({at,progress:{isActive:true,stage,message,currentFile:'本轮.docx',completedCount:0,totalCount:8},ui:{visible:true,message,completed:0,total:8,percent:10,animationName:'mw-read-shimmer'},...extras});
test('知识生成进度只以真实同阶段时长及UI一致记录判定中长等待覆盖',()=>{
 const result=assessKnowledgeProgress([sample(1000,'read_source','正在读取内容'),sample(7000,'read_source','正在加载目标资料'),sample(33000,'read_source','文档内容比较多，正在逐页梳理结构'),sample(34000,'build_summary','摘要数据构建中')]);
 assert.deepEqual(result.missing,[]);assert.equal(result.matched,4);assert.equal(result.medium,true);assert.equal(result.long,true);assert.equal(result.animated,true);assert.deepEqual(result.invalid,[]);
 const rotationOnly=assessKnowledgeProgress([sample(1000,'read_source','正在读取内容'),sample(7000,'read_source','正在加载目标资料'),sample(33000,'read_source','正在加载目标资料')]);
 assert.equal(rotationOnly.medium,true);assert.equal(rotationOnly.long,false);
 const arbitrary=assessKnowledgeProgress([sample(1000,'parse_source','解析开始'),sample(33000,'parse_source','复杂文件仍在处理')]);
 assert.equal(arbitrary.medium,false);assert.equal(arbitrary.long,false);
 const cooldown=assessKnowledgeProgress([sample(1000,'read_source','正在读取内容'),sample(7000,'read_source','命中限流，等待 20 秒后继续'),sample(33000,'read_source','命中限流，等待 1 秒后继续')]);
 assert.equal(cooldown.medium,false);assert.equal(cooldown.long,false);
});
test('快速完成未捕获时长分支不能用阶段文案替代完整覆盖',()=>{
 const result=assessKnowledgeProgress([sample(1000,'parse_source','开始'),sample(1500,'read_source','正文')]);
 assert.equal(result.medium,false);assert.equal(result.long,false);assert.ok(result.missing.includes('中长等待实际文案分支')||result.missing.includes('同阶段长等待文案变化'));
});
test('知识进度超范围值和滞后UI分别留证而不冒充同步通过',()=>{
 const stale=sample(1000,'read_source','新动作');stale.ui.message='旧动作';
 const bad=sample(2000,'read_source','新动作');bad.ui.percent=120;bad.ui.completed=10;
 const result=assessKnowledgeProgress([stale,bad]);
 assert.equal(result.matched,0);assert.equal(result.invalid.length,1);assert.ok(result.missing.includes('API与UI一致的实际执行进度'));
});
