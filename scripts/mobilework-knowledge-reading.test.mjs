import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareKnowledgeReading,assessSingleKnowledge,assessWikiDocument,assessKnowledgeCard,flattenWikiNodes} from './mobilework-knowledge-reading.mjs';
import {dismissOwnedKnowledgeDialog} from './mobilework-knowledge-resources.mjs';
import {completedKnowledgeParse} from './mobilework-knowledge-parse.mjs';

test('单文档材料与范围判定拒绝全量替代、对照污染及旧终态',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-kb-reading-'));
 try{
  const fixture=await prepareKnowledgeReading({source_dir:[dir]},{single:true}),[target,control]=fixture.inputs;
  assert.ok((await fs.readFile(target.path,'utf8')).includes(fixture.code));assert.ok(!control.content.includes(fixture.code));
  const input={target,control,files:[{path:target.path,status:'success'},{path:control.path,status:'unparsed'}],requests:[{route:'/knowledge/parse_source',source_file:target.path}],targetText:target.content,controlRawExists:false,facts:[fixture.code,fixture.budget,fixture.owner,'权限功能待复核']};
  assert.deepEqual(assessSingleKnowledge(input),{targetedRequest:true,targetSuccess:true,controlUnparsed:true,controlRawAbsent:true,missingFacts:[]});
  assert.equal(assessSingleKnowledge({...input,requests:[...input.requests,{route:'/knowledge/full_update'}]}).targetedRequest,false);
  const polluted=assessSingleKnowledge({...input,controlRawExists:true,files:input.files.map(item=>({...item,status:'success'})),targetText:'模型声称已完成'});
  assert.equal(polluted.controlUnparsed,false);assert.equal(polluted.controlRawAbsent,false);assert.equal(polluted.missingFacts.length,4);
  assert.equal(completedKnowledgeParse({stage:'completed',isActive:false,completedCount:1},{completedCount:0},false),true);
  assert.equal(completedKnowledgeParse({stage:'completed',isActive:false,completedCount:1},{completedCount:1},false),false);
 }finally{await fs.rm(dir,{recursive:true});}
});

test('Wiki完整正文与全树判断不能由首屏截断、重复名称或上下布局冒充',()=>{
 const tree=[{name:'wiki',type:'directory',children:[{name:'sources',type:'directory',children:[{name:'报告.md',type:'file',path:'sources/报告.md'}]},{name:'concepts',type:'directory',children:[{name:'报告.md',type:'file',path:'concepts/报告.md'}]}]}];
 const nodes=flattenWikiNodes(tree);assert.equal(nodes.length,5);assert.equal(nodes.filter(node=>node.name==='报告.md').length,2);
 const source='# 项目报告\n\n## 数据\n\n| 负责人 | 预算 |\n|---|---|\n| 林澈 | 48000 |\n\n末尾风险：权限待复核。',left={x:10,y:10,width:300,height:600},right={x:330,y:10,width:700,height:600};
 assert.equal(assessWikiDocument({source,documentText:source.replaceAll('\n','\r\n'),left,right}).complete,true);
 assert.equal(assessWikiDocument({source,documentText:source.split('末尾风险')[0],left,right}).complete,false);
 assert.equal(assessWikiDocument({source,documentText:source,left,right:{...right,x:10,y:620}}).sideBySide,false);
});

test('知识卡片元数据与关联全集独立判定，摘要不能冒充完整正文',()=>{
 const detail={title:'预算审核',updated_at:'2026-11-01',tags:['concept'],summary:'双人复核预算。',content:'双人复核预算。\n\n权限尚未验收，不能上线。',related_cards:[{id:'entity:林澈',title:'林澈'}],related_wikis:[{id:'source:项目报告',title:'项目报告'}]};
 const observed={title:detail.title,body:detail.title+'\n2026-11-01\n'+detail.summary,contentArea:{text:detail.summary,width:400,height:44,clientWidth:400,clientHeight:44,scrollWidth:400,scrollHeight:44,overflowX:'hidden',overflowY:'hidden'},tags:['概念'],relatedCards:['林澈'],relatedWikis:['项目报告']};
 const result=assessKnowledgeCard(detail,observed);assert.equal(result.summary,true);assert.equal(result.fullContent,false);assert.equal(result.relatedCards,true);assert.equal(result.relatedWikis,true);
 assert.equal(assessKnowledgeCard(detail,{...observed,body:observed.body+'\n'+detail.content,contentArea:{...observed.contentArea,text:detail.content,height:120,clientHeight:120,scrollHeight:120}}).fullContent,true);
 assert.equal(assessKnowledgeCard(detail,{...observed,body:observed.body+'\n'+detail.content,contentArea:{...observed.contentArea,text:detail.content,scrollHeight:120}}).fullContent,false);
 const bad=assessKnowledgeCard(detail,{...observed,relatedCards:['林澈','林澈'],relatedWikis:[],tags:['实体']});
 assert.equal(bad.relatedCards,false);assert.equal(bad.relatedWikis,false);assert.equal(bad.tags,false);
});

test('旧Wiki预览只有标题时保留归属，不以同名窗口认领',async()=>{
 const owned={previewTitle:'本轮项目Wiki'},actions=[];
 const page={getByRole:()=>{actions.push('role lookup');throw Error('不应按标题定位');},locator:()=>{actions.push('DOM lookup');throw Error('旧标题缺少真实ID，不应操作DOM');}};
 await assert.rejects(dismissOwnedKnowledgeDialog(page,owned),error=>error.blocked&&/只有标题/.test(error.message));
 assert.deepEqual(owned,{previewTitle:'本轮项目Wiki'});assert.deepEqual(actions,[]);
});
