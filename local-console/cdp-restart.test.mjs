import test from 'node:test';
import assert from 'node:assert/strict';
import {restartFlow,probeCdp,requestClientQuit} from './cdp-restart.mjs';
test('无 CDP 的托盘客户端明确提示完全退出，不尝试关闭窗口',async()=>{
 let connected=false;
 await assert.rejects(()=>requestClientQuit(false,async()=>{connected=true;}),/系统托盘/);
 assert.equal(connected,false);
});
test('通过主界面的正常退出接口退出，而不是关闭窗口',async()=>{
 let quit=false,disconnected=false;
 const old=globalThis.window;globalThis.window={__OPENWORK_ELECTRON__:{shell:{quit:()=>{quit=true;}}}};
 try{
  await requestClientQuit(true,async()=>({contexts:()=>[{pages:()=>[{url:()=> 'file:///MobileWork/resources/app-dist/index.html',evaluate:fn=>fn()}]}],close:async()=>{disconnected=true;}}));
  await new Promise(r=>setTimeout(r,150));assert.equal(quit,true);assert.equal(disconnected,true);
 }finally{globalThis.window=old;}
});
test('重启依次检查、备份修改、退出、启动、验证',async()=>{
 const calls=[];let count=0;
 const r=await restartFlow({checkIdle:async()=>calls.push('check'),enable:async()=>{calls.push('enable');return {allowed:true};},close:async()=>calls.push('close'),launch:async()=>calls.push('launch'),probe:async()=>({connected:++count===2,port:9223}),wait:async()=>{}});
 assert.deepEqual(calls,['check','enable','close','launch']);assert.equal(r.connected,true);
});
test('有任务或无法确认状态时不修改、不关闭、不启动',async()=>{
 let touched=false;await assert.rejects(()=>restartFlow({checkIdle:async()=>{throw Error('运行中');},enable:async()=>{touched=true;}}),/运行中/);assert.equal(touched,false);
});
test('正常退出失败时不启动第二个进程；端口未连通不报告成功',async()=>{
 let launched=false;await assert.rejects(()=>restartFlow({checkIdle:async()=>{},enable:async()=>({}),close:async()=>{throw Error('仍在后台');},launch:async()=>{launched=true;}}),/仍在后台/);assert.equal(launched,false);
 await assert.rejects(()=>restartFlow({checkIdle:async()=>{},enable:async()=>({}),close:async()=>{},launch:async()=>{},probe:async()=>({connected:false}),wait:async()=>{},attempts:2}),/未能连接/);
 await assert.rejects(()=>probeCdp(-1),/端口无效/);
});
