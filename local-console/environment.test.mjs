import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {resolveEnvironment} from './environment.mjs';
import {createConsole,projectRoot,defaultConsoleDataDir} from './server.mjs';
import {launchConsole} from './launch.mjs';

test('新用户、不同磁盘、相对路径和环境变量可迁移',()=>{
 const root='E:\\测试平台',homeDir='C:\\Users\\新用户';
 const auto=resolveEnvironment({root,homeDir,env:{},exists:()=>false});
 assert.equal(auto.clientExecutable,path.join(homeDir,'AppData','Local','Programs','MobileWork','MobileWork.exe'));
 assert.equal(auto.clientHome,path.join(homeDir,'.mobilework'));assert.equal(auto.taskRoot,path.join(homeDir,'MobileWork'));
 const config=resolveEnvironment({root,homeDir,env:{},config:{clientExecutable:'client/MobileWork.exe',clientHome:'profile',skillsRoot:'skills',browserExecutable:'runtime/browser.exe'}});
 assert.equal(config.browserExecutable,path.resolve(root,'runtime/browser.exe'));assert.equal(config.discoveryPath,path.resolve(root,'profile/electron/openwork-ui-control.json'));
 const override=resolveEnvironment({root,homeDir,env:{MW_CLIENT_EXECUTABLE:'F:\\MobileWork.exe'},config:{clientExecutable:'unused'}});
 assert.equal(override.clientExecutable,'F:\\MobileWork.exe');
});
test('启动只复用同一目录的服务',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-launch-test-'));
 const app=await createConsole({port:0,dataDir:dir});
 try{const port=app.server.address().port;assert.ok(port<=65515);const reused=await launchConsole({port,openBrowser:false});assert.equal(reused.existing,true);assert.equal((await(await fetch(app.url+'/api/state')).json()).projectRoot,projectRoot);}
 finally{await new Promise(r=>app.server.close(r));}
});
test('其他目录占用固定端口时报错，保留原服务且不换端口',async()=>{
 const foreign=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({projectRoot:'E:\\其他测试包'}));});
 await new Promise(r=>foreign.listen(0,'127.0.0.1',r));let app;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-foreign-console-'));
 try{
  const port=foreign.address().port;assert.ok(port<=65515);
  const attempts=[];
  await assert.rejects(()=>launchConsole({port,openBrowser:false,create:opts=>{attempts.push(opts.port);return createConsole({...opts,dataDir:dir});}}),/固定端口.*已被占用，未自动换端口/);
  assert.deepEqual(attempts,[port]);
  assert.equal((await(await fetch('http://127.0.0.1:'+port+'/api/state')).json()).projectRoot,'E:\\其他测试包');
 }finally{if(app)await new Promise(r=>app.server.close(r));await new Promise(r=>foreign.close(r));}
});
test('数据存储指针读取独立目录并拒绝越界',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-console-store-'));
 assert.equal(await defaultConsoleDataDir(dir),dir);
 const target=path.join(dir,'stores','new');await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'settings.json'),'{}');
 await fs.writeFile(path.join(dir,'current-store.json'),JSON.stringify({version:1,relativePath:'stores/new'}));assert.equal(await defaultConsoleDataDir(dir),target);
 await fs.writeFile(path.join(dir,'current-store.json'),JSON.stringify({version:1,relativePath:'../outside'}));await assert.rejects(()=>defaultConsoleDataDir(dir),/必须位于/);
});
