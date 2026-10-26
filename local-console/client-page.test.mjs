import test from 'node:test';
import assert from 'node:assert/strict';
import {isClientPageUrl,uniqueClientPage} from './client-page.mjs';
import {TaskScheduler} from './task-scheduler.mjs';
import {probeCdp} from './cdp-restart.mjs';
import http from 'node:http';
test('主界面支持新旧地址并拒绝伪装地址及多主界面',()=>{
 for(const url of ['mobilework-shell://app/index.html#/workspace/a/session/b','file:///C:/Users/demo/MobileWork/resources/app-dist/index.html#/session/a'])assert.equal(isClientPageUrl(url),true,url);
 for(const url of [null,'','mobilework-shell://other/index.html','mobilework-shell://app/other.html','https://example.com/MobileWork/resources/app-dist/index.html','https://example.com/?url=mobilework-shell://app/index.html','mobilework-shell://user@app/index.html'])assert.equal(isClientPageUrl(url),false,String(url));
 const page={url:()=> 'mobilework-shell://app/index.html'},other={url:()=> 'https://example.com'};
 const browser=pages=>({contexts:()=>[{pages:()=>pages}]});
 assert.equal(uniqueClientPage(browser([other,page])),page);
 assert.throws(()=>uniqueClientPage(browser([other])),/唯一/);
 assert.throws(()=>uniqueClientPage(browser([page,page])),/唯一/);
 const scheduler=new TaskScheduler(),job={id:'a',status:'QUEUED',config:{cdpPort:9223}};
 scheduler.enqueue(job,{cooperative:true,start:()=>{}});scheduler.acquire('a','PREPARING');
 assert.throws(()=>scheduler.release('a',{url:'mobilework-shell://app/index.html#/session/ses_other',sessionId:'ses_a'}),/不一致/);
 scheduler.release('a',{url:'mobilework-shell://app/index.html#/session/ses_a',sessionId:'ses_a'});
 assert.equal(job.sessionId,'ses_a');
});
test('CDP探测接受新版和旧版唯一主界面，拒绝多页面及无主界面',async()=>{
 let rows=[];const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rows));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const port=server.address().port;
  for(const url of ['mobilework-shell://app/index.html#/session/a','file:///C:/MobileWork/resources/app-dist/index.html']){rows=[{type:'page',url},{type:'page',url:'https://example.com'}];assert.equal((await probeCdp(port)).connected,true);}
  rows=[{type:'page',url:'mobilework-shell://app/index.html'},{type:'page',url:'mobilework-shell://app/index.html#/other'}];assert.equal((await probeCdp(port)).connected,false);
  rows=[{type:'page',url:'https://example.com/MobileWork/resources/app-dist/index.html'}];assert.equal((await probeCdp(port)).connected,false);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
