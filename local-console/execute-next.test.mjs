import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskScheduler} from './task-scheduler.mjs';

// The manual-overlap feature was retired on 2026-10-22.
test('执行下条入口已撤销，不能绕过串行调度',()=>{
 const scheduler=new TaskScheduler();
 const job={id:'legacy',status:'QUEUED',config:{cdpPort:9223,executionStrategy:'parallel',maxParallel:16}};
 scheduler.enqueue(job,{cooperative:true,start:()=>{}});
 assert.equal(scheduler.nextStatus(job.id).ready,false);
 assert.throws(()=>scheduler.advance(job.id,'next'),/取消并行/);
});
