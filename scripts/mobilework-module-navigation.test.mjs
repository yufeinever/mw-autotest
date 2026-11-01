import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreModuleNavigation} from './mobilework-module-navigation.mjs';

test('本轮RPA入口收尾返回原页面并等待输入区就绪',async()=>{
 const origin='mobilework-shell://app/index.html#/workspace/ws_test/session',calls=[];
 const owned={moduleNavigation:{originUrl:origin,targetHash:'#/experts/staff'}};
 const page={url:()=> 'mobilework-shell://app/index.html#/experts/staff',goto:async url=>calls.push(url),getByRole:(role,options)=>({waitFor:async()=>calls.push(role+':'+options.name)})};
 await restoreModuleNavigation(page,owned);
 assert.deepEqual(calls,[origin,'button:运行任务']);assert.equal(owned.moduleNavigation,undefined);
});

test('切到无关模块后保留原归属，不导航或清理其他页面',async()=>{
 const marker={originUrl:'mobilework-shell://app/index.html#/workspace/ws_test/session',targetHash:'#/experts/staff'},owned={moduleNavigation:marker};let navigated=false;
 await assert.rejects(()=>restoreModuleNavigation({url:()=> 'mobilework-shell://app/index.html#/knowledge',goto:async()=>{navigated=true;}},owned),/离开本轮入口/);
 assert.equal(navigated,false);assert.equal(owned.moduleNavigation,marker);
});
