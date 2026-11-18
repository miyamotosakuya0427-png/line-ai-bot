"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createExecutionRecoveryScheduler}=require("./execution-recovery-scheduler");
test("recovery scheduler runs bounded PostgreSQL recovery batches",async()=>{
 const calls=[];
 const scheduler=createExecutionRecoveryScheduler({executionKernel:{async recoverExpiredWorkers(args){calls.push(args);return[{workerId:"worker-1",recovered:true}];}},batchSize:10});
 assert.deepEqual(await scheduler.runOnce(),{skipped:false,results:[{workerId:"worker-1",recovered:true}]});
 assert.deepEqual(calls,[{limit:10}]);
});
test("recovery scheduler rejects overlapping scans",async()=>{
 let release;
 const wait=new Promise(resolve=>release=resolve);
 const scheduler=createExecutionRecoveryScheduler({executionKernel:{async recoverExpiredWorkers(){await wait;return[];}}});
 const first=scheduler.runOnce();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(await scheduler.runOnce(),{skipped:true,reason:"recovery scan already running"});
 release();await first;
});
test("recovery scheduler surfaces scan errors to audit hook and caller",async()=>{
 const errors=[];
 const expected=new Error("database unavailable");
 const scheduler=createExecutionRecoveryScheduler({executionKernel:{async recoverExpiredWorkers(){throw expected;}},onError:e=>errors.push(e)});
 await assert.rejects(()=>scheduler.runOnce(),/database unavailable/);
 assert.deepEqual(errors,[expected]);
});
test("scheduler lifecycle is idempotent",()=>{
 const scheduler=createExecutionRecoveryScheduler({executionKernel:{async recoverExpiredWorkers(){return[];}},intervalMs:60000});
 assert.equal(scheduler.start().started,true);
 assert.equal(scheduler.start().started,false);
 assert.equal(scheduler.started,true);
 scheduler.stop();assert.equal(scheduler.started,false);
 scheduler.stop();
});
