import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {releaseCaseFavorites,adoptCaseTaskDraft,favoriteHashes} from './mobilework-case-library.mjs';

function registryPage(initial){
 let value=structuredClone(initial),writes=0;
 const window={__MOBILEWORK__:{invoke:async(name,args)=>{
  if(name==='auth:current')return {account:{id:'test-account'}};
  assert.equal(args.accountId,'test-account');assert.equal(args.path,'explore/registry.json');
  if(name==='store:read')return {value:structuredClone(value)};
  assert.equal(name,'store:write');value=structuredClone(args.value);writes++;return {ok:true};
 }}};
 return {evaluate:(fn,input)=>vm.runInNewContext('('+fn.toString()+')(input)',{window,input}),value:()=>value,writes:()=>writes};
}
const targets=Array.from({length:5},(_,i)=>({id:'case-'+i,title:'官方案例'+i,category:'通用领域'}));

test('收藏恢复只移除本轮五项，保留用户当前修改及其他新增项',async()=>{
 const user={favorite:true,title:'用户已有收藏',category:'经营管理'},current={user:{...user,title:'用户运行期间修改'},extra:{favorite:true,title:'用户新增',category:'经营管理'},...Object.fromEntries(targets.map(t=>[t.id,{favorite:true,title:t.title,category:t.category}]))};
 const page=registryPage(current),owned={accountId:'test-account',beforeHashes:favoriteHashes({user}),targets};
 await releaseCaseFavorites(page,owned);
 assert.deepEqual(page.value(),{user:current.user,extra:current.extra});assert.equal(page.writes(),1);
 await releaseCaseFavorites(page,owned);assert.deepEqual(page.value(),{user:current.user,extra:current.extra});
});

test('收藏目标被用户改变时先报错，不写回或删除其他收藏',async()=>{
 const current=Object.fromEntries(targets.map(t=>[t.id,{favorite:true,title:t.title,category:t.category}]));current['case-3'].title='用户更改';
 const page=registryPage(current);
 await assert.rejects(releaseCaseFavorites(page,{accountId:'test-account',beforeHashes:{},targets}),/本轮收藏内容已改变/);
 assert.deepEqual(page.value(),current);assert.equal(page.writes(),0);
});

test('做同款收尾保留无关页面，点击前停止仍交给本轮回放关闭',async()=>{
 const resource={caseTask:{originUrl:'mobilework-shell://app/index.html#/workspace/ws_test/session',workspaceId:'ws_test',prompt:'本轮原提示',editedPrompt:null},caseReplay:{title:'测试案例'},moduleNavigation:{targetHash:'#/explore'}};
 await assert.rejects(adoptCaseTaskDraft({url:()=> 'mobilework-shell://app/index.html#/workspace/ws_other/session'},resource),/未交接到本轮空间/);
 assert.ok(resource.caseTask);assert.ok(resource.caseReplay);
 assert.equal(await adoptCaseTaskDraft({url:()=> 'mobilework-shell://app/index.html#/explore'},resource),null);
 assert.equal(resource.caseTask,undefined);assert.ok(resource.caseReplay);assert.ok(resource.moduleNavigation);
});
