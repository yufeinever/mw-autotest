import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assessKnowledgeGraph,assessGraphHighlight,blankGraphPoint,nextKnowledgeSchedule,knowledgeDirectoryManifest,relocatedKnowledgePath} from './mobilework-knowledge-graph-settings.mjs';
import {ownedKnowledgeCandidate,releaseKnowledgeCreation,dismissOwnedKnowledgeDialog} from './mobilework-knowledge-resources.mjs';

test('图谱观察拒绝节点缺失、错配色线型、标签阈值及伪造高亮',()=>{
 const graph={nodes:[{id:'a',kind:'entity',label:'林澈',has_source:true,has_content:true},{id:'b',kind:'concept',label:'预算',has_source:true,has_content:true},{id:'c',kind:'entity',label:'缺来源',has_source:false,has_content:false},{id:'d',kind:'concept',label:'空内容',has_source:true,has_content:false},{id:'e',kind:'concept',label:'未关联',has_source:true,has_content:true}],edges:[{id:'ab',source:'a',target:'b',strength:'strong'},{id:'ac',source:'a',target:'c',strength:'weak'},{id:'ad',source:'a',target:'d',strength:'strong'},{id:'bc',source:'b',target:'c',strength:'strong'},{id:'bd',source:'b',target:'d',strength:'weak'}]};
 const palette={entity:'#111111',concept:'#0000ff',missingEntity:'#aaaaaa',missingConcept:'#aabbff'};
 const observed={zoom:.6,palette,nodes:graph.nodes.map(node=>({id:node.id,size:12,fill:node.id==='a'?palette.entity:node.id==='c'?palette.missingEntity:node.id==='d'?palette.missingConcept:palette.concept,labelText:node.label,opacity:node.id==='e'?.65:1,position:[0,0],client:[90,90]})),edges:graph.edges.map(edge=>({id:edge.id,lineDash:edge.strength==='weak'?[5,5]:undefined,opacity:edge.source==='a'?1:.35}))};
 const good=assessKnowledgeGraph(graph,observed);assert.equal(good.sameIds,true);assert.ok(good.nodes.every(n=>n.size&&n.color&&n.label));assert.ok(good.edges.every(e=>e.style));assert.deepEqual(good.missingBranches,['不同尺寸档位']);
 const damaged=structuredClone(observed);damaged.nodes[0].fill=palette.concept;damaged.nodes[1].size=48;damaged.edges[1].lineDash=[];
 const bad=assessKnowledgeGraph(graph,damaged);assert.equal(bad.nodes[0].color,false);assert.equal(bad.nodes[1].size,false);assert.equal(bad.edges[1].style,false);
 assert.equal(assessKnowledgeGraph(graph,{...observed,nodes:observed.nodes.slice(1)}).sameIds,false);
 assert.ok(!assessKnowledgeGraph(graph,{...observed,zoom:.599}).nodes.every(n=>n.label));assert.ok(assessKnowledgeGraph(graph,{...observed,zoom:.599,nodes:observed.nodes.map(n=>({...n,labelText:''}))}).nodes.every(n=>n.label));
 assert.deepEqual(assessGraphHighlight(graph,observed,'a'),{related:true,other:true,edges:true});assert.equal(assessGraphHighlight(graph,{...observed,nodes:observed.nodes.map(n=>({...n,opacity:1}))},'a').other,false);
 const blank=blankGraphPoint({...observed,rect:{x:0,y:0,width:700,height:600}});assert.ok(observed.nodes.every(n=>Math.hypot(blank.x-n.client[0],blank.y-n.client[1])>30));
});

test('每日计划跨日且迁移清单验证真实副本与源保护',async()=>{
 const now=new Date(2026,10,1,23,59,30),schedule=nextKnowledgeSchedule(now);assert.equal(schedule.time,'00:01');assert.equal(new Date(schedule.at).getDate(),2);assert.ok(new Date(schedule.at)>now);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-kb-storage-'));
 try{
  const from=path.join(dir,'原库'),to=path.join(dir,'新库');await fs.mkdir(path.join(from,'knowledge/wiki/sources'),{recursive:true});await fs.mkdir(path.join(from,'information'));await fs.writeFile(path.join(from,'information/事实.md'),'合成随机事实');
  const before=await knowledgeDirectoryManifest(from);await fs.cp(from,to,{recursive:true});assert.deepEqual(await knowledgeDirectoryManifest(to),before);assert.deepEqual(await knowledgeDirectoryManifest(from),before);
  await fs.writeFile(path.join(to,'information/事实.md'),'错误副本');assert.notDeepEqual(await knowledgeDirectoryManifest(to),before);assert.deepEqual(await knowledgeDirectoryManifest(from),before);
  assert.equal(relocatedKnowledgePath(path.join(from,'knowledge'),from,to),path.join(to,'knowledge'));assert.equal(relocatedKnowledgePath(path.join(dir,'用户外部源'),from,to),path.join(dir,'用户外部源'));
 }finally{await fs.rm(dir,{recursive:true});}
});

test('存储迁移收尾只接管登记同ID新路径、提交未决不放行',()=>{
 const from=path.resolve('tmp/原库'),to=path.resolve('tmp/本轮新库'),owned={name:'MW-Autotest-KB-141-01234567',id:'new-id',beforeIds:['user-id'],storageDir:from,sourceDir:null,submitted:true,storageMove:{from,to,state:'submitted'}};
 const item={id:'new-id',name:owned.name,storage_dir:to,wiki_dir:path.join(to,'knowledge'),source_dir:[path.join(to,'information'),path.join(to,'resource')]};
 assert.equal(ownedKnowledgeCandidate([item],owned).storage_dir,to);
 assert.equal(ownedKnowledgeCandidate([{...item,id:'user-id'}],owned),null);
 assert.throws(()=>ownedKnowledgeCandidate([{...item,id:'another-id'}],owned),/实际ID/);
 assert.throws(()=>ownedKnowledgeCandidate([{...item,storage_dir:from,wiki_dir:path.join(from,'knowledge')}],owned),/请求结果仍未确认/);
 assert.throws(()=>ownedKnowledgeCandidate([{...item,source_dir:[path.resolve('tmp/用户源')]}],owned),/迁移后的源目录/);
 assert.throws(()=>ownedKnowledgeCandidate([item],{...owned,storageMove:{...owned.storageMove,state:'picking'}}),/路径不符合/);
 assert.throws(()=>ownedKnowledgeCandidate([{...item,storage_dir:path.resolve('tmp/用户资料')}],owned),/路径不符合/);
});

test('异常收尾先关闭本轮定时计划再移除注册，图谱仅按归属退出',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-kb-release-')),events=[],oldFetch=globalThis.fetch;
 try{
  const item={id:'owned-id',name:'MW-Autotest-KB-140-01234567',storage_dir:dir,wiki_dir:path.join(dir,'knowledge'),source_dir:[path.join(dir,'information'),path.join(dir,'resource')],open_update:true};let removed=false;
  globalThis.fetch=async(url,options={})=>{
   const route=new URL(url).pathname,payload=options.body&&JSON.parse(options.body);events.push({route,payload});let data;
   if(route==='/knowledge/list')data=removed?[]:[item];
   else if(route.endsWith('/progress'))data={isActive:false,pause:false};
   else if(route==='/knowledge/update_config'){item.open_update=false;data=item.id;}
   else if(route==='/knowledge/remove'){assert.equal(item.open_update,false);removed=true;data=item.id;}
   else if(route==='/knowledge/'+item.id)data=item;else throw Error('意外路由'+route);
   return {ok:true,status:200,json:async()=>({success:'true',data})};
  };
  const page={evaluate:async()=>({baseUrl:'http://127.0.0.1:19000',ownerToken:'synthetic-token'}),getByRole:()=>({filter:()=>({count:async()=>0})})};
  const resources={knowledgeCreation:{name:item.name,id:item.id,beforeIds:[],storageDir:dir,sourceDir:null,submitted:true,scheduleTime:'00:01'}};
  await releaseKnowledgeCreation(page,resources);assert.equal(resources.knowledgeCreation,undefined);assert.ok(events.findIndex(e=>e.route==='/knowledge/update_config')<events.findIndex(e=>e.route==='/knowledge/remove'));
  const actions=[],scope={getByRole:(role,{name})=>({filter:()=>({count:async()=>name==='退出全屏'?1:0,click:async()=>actions.push('退出本轮全屏')}),waitFor:async()=>actions.push('确认退出')})};
  await dismissOwnedKnowledgeDialog({locator:selector=>{assert.equal(selector,'[data-mw-knowledge-graph-owner="owned-token"]');return scope;}},{graphToken:'owned-token'});assert.deepEqual(actions,['退出本轮全屏','确认退出']);
 }finally{globalThis.fetch=oldFetch;await fs.rm(dir,{recursive:true});}
});
