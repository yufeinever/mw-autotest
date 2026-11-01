import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {ownedKnowledgeCandidate,knowledgeRemovalSettled,dismissOwnedKnowledgeDialog} from './mobilework-knowledge-resources.mjs';
import {sourceTreeFiles} from './client-knowledge-management-steps.mjs';

const owned={name:'MW-Autotest-KB-115-01234567',beforeIds:['user-id'],storageDir:path.resolve('tmp/owned-knowledge'),sourceDir:path.resolve('tmp/owned-source'),submitted:true};
const item={id:'new-id',name:owned.name,storage_dir:owned.storageDir,wiki_dir:path.join(owned.storageDir,'knowledge'),source_dir:[owned.sourceDir]};
test('知识库创建接管仅接受新增ID及登记完整路径',()=>{
 assert.deepEqual(ownedKnowledgeCandidate([{...item,id:'user-id'},item],owned),item);
 assert.equal(ownedKnowledgeCandidate([{...item,id:'user-id'},{...item,id:'other',name:'用户知识库'}],owned),null);
 assert.equal(ownedKnowledgeCandidate([],owned),null);
});
test('同名新库路径或源目录不符时拒绝接管',()=>{
 for(const change of [{storage_dir:path.resolve('tmp/user')},{wiki_dir:path.resolve('tmp/elsewhere')},{source_dir:[path.resolve('tmp/other')]}])assert.throws(()=>ownedKnowledgeCandidate([{...item,...change}],owned),/路径不符合创建前归属/);
});
test('同名多个新ID保留现场不任取首个',()=>{
 assert.throws(()=>ownedKnowledgeCandidate([item,{...item,id:'second-id'}],owned),/多个新ID/);
});
test('知识源完整树遍历保留嵌套文件和真实状态',()=>{
 const files=sourceTreeFiles([{type:'directory',children:[{type:'file',name:'报告.docx',path:'D:/source/报告.docx',status:'pending'},{type:'directory',children:[{type:'file',name:'台账.xlsx',path:'D:/source/nested/台账.xlsx',status:'unable_parse'}]}]},{type:'file',name:'纪要.md',path:'D:/source/纪要.md',status:'ready'}]);
 assert.deepEqual(files.map(file=>file.name),['报告.docx','台账.xlsx','纪要.md']);assert.equal(files[1].status,'unable_parse');
});

test('知识库列表归属：改名后的同ID可收尾且未知改名保留',()=>{
 const renamed={...owned,id:item.id,renamedName:owned.name+'-改名'};
 assert.equal(ownedKnowledgeCandidate([{...item,name:renamed.renamedName}],renamed).id,item.id);
 assert.equal(ownedKnowledgeCandidate([{...item,name:'用户另起名称'}],renamed),null);
 assert.throws(()=>ownedKnowledgeCandidate([{...item,id:'replacement',name:renamed.renamedName}],renamed),/实际ID/);
});

test('知识库列表归属：确认移除必须实际缺失ID而非名称不匹配',()=>{
 const removing={...owned,id:item.id,removing:true};
 assert.equal(knowledgeRemovalSettled(removing,[]),true);
 assert.equal(knowledgeRemovalSettled(removing,[{...item,name:'用户另起名称'}]),false);
 assert.equal(knowledgeRemovalSettled({...removing,id:'user-id'},[]),false);
 assert.equal(knowledgeRemovalSettled({...removing,removing:false},[]),false);
 assert.equal(knowledgeRemovalSettled({...removing,id:null},[]),false);
});

test('知识库列表归属：原新名两候选和改名路径变化均拒绝移除',()=>{
 const renamed={...owned,id:item.id,renamedName:owned.name+'-改名'};
 assert.throws(()=>ownedKnowledgeCandidate([item,{...item,id:'other-id',name:renamed.renamedName}],renamed),/多个新ID/);
 assert.throws(()=>ownedKnowledgeCandidate([{...item,name:renamed.renamedName,storage_dir:path.resolve('tmp/user-folder')}],renamed),/路径不符合/);
});

test('知识库列表归属：强停只取消登记的真实弹窗元素',async()=>{
 const token='01234567-1234-1234-1234-0123456789ab',scopes=[],actions=[];
 const page={locator:selector=>{scopes.push(selector);return {count:async()=>1,getByRole:(role,options)=>({click:async()=>actions.push({role,...options})}),waitFor:async options=>actions.push(options)};}};
 const pending={dialogToken:token};await dismissOwnedKnowledgeDialog(page,pending);
 assert.deepEqual(scopes,['[data-mw-knowledge-owner="'+token+'"]']);
 assert.deepEqual(actions,[{role:'button',name:'取消',exact:true},{state:'hidden'}]);assert.equal(pending.dialogToken,undefined);
 await dismissOwnedKnowledgeDialog(page,{});assert.equal(scopes.length,1);
});
