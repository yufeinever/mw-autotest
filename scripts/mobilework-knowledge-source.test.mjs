import test from 'node:test';
import assert from 'node:assert/strict';
import {completedKnowledgeParse} from './mobilework-knowledge-parse.mjs';
import {flattenKnowledgeFiles,matchingKnowledgeNames,hasKnowledgeBudget} from './mobilework-knowledge-source-ui.mjs';

test('知识库解析终态不能复用上一轮完成批次',()=>{
 const previous={stage:'completed',completedCount:3,completionBatchId:'old'};
 assert.equal(completedKnowledgeParse({...previous,isActive:false},previous,false),false);
 assert.equal(completedKnowledgeParse({...previous,isActive:false,completionBatchId:'new'},previous,false),true);
 assert.equal(completedKnowledgeParse({...previous,isActive:false},previous,true),true);
 assert.equal(completedKnowledgeParse({...previous,isActive:true},previous,true),false);
 assert.equal(completedKnowledgeParse({stage:'completed',completedCount:1,isActive:false},{completedCount:0},false),true);
});

test('知识库源树保留嵌套真实状态且名称搜索排除非匹配项',()=>{
 const files=flattenKnowledgeFiles([{type:'directory',name:'资料',children:[{type:'file',name:'Alpha报告.md',path:'D:/资料/Alpha报告.md',status:'success'},{type:'directory',children:[{type:'file',name:'Beta.bin',path:'D:/资料/目录/Beta.bin',status:'unable_parse'}]}]}]);
 assert.deepEqual(files.map(item=>[item.path,item.status]),[['D:/资料/Alpha报告.md','success'],['D:/资料/目录/Beta.bin','unable_parse']]);
 assert.deepEqual(matchingKnowledgeNames(files,' alpha '),['Alpha报告.md']);assert.deepEqual(matchingKnowledgeNames(files,'无匹配'),[]);
});

test('知识库预算事实允许合法金额排版而不把不同金额判通过',()=>{
 assert.equal(hasKnowledgeBudget('预算48,526元',48526),true);
 assert.equal(hasKnowledgeBudget('预算4.8526万元',48526),true);
 assert.equal(hasKnowledgeBudget('预算148526元',48526),false);
 assert.equal(hasKnowledgeBudget('预算48,526.8元',48526),false);
});
