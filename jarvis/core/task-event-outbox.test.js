"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {createTaskEventOutbox}=require("./task-event-outbox");

function fixture(){
  const client=new EventEmitter();
  const calls=[];
  let releaseCalls=0,releaseError=null;
  client.query=async sql=>{calls.push(sql);return {rows:[]};};
  client.release=error=>{releaseCalls++;releaseError=error||null;};
  const pool={query:async()=>({rows:[]}),connect:async()=>client};
  return {client,calls,pool,get releaseCalls(){return releaseCalls;},get releaseError(){return releaseError;}};
}

test("LISTEN client backend termination is handled without an uncaught error and wakes replay",async()=>{
  const f=fixture(),wakeups=[];
  const outbox=createTaskEventOutbox({pool:f.pool});
  const close=await outbox.listen(async cursor=>{wakeups.push(cursor);});
  f.client.emit("notification",{channel:"jarvis_task_events",payload:"7"});
  assert.deepEqual(wakeups,[7]);
  f.client.emit("error",Object.assign(new Error("simulated backend termination"),{code:"57P01"}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(wakeups,[7,0],"listener loss signals the SSE replay loop");
  assert.equal(f.releaseCalls,1,"lost checked-out client is released exactly once");
  assert.ok(f.releaseError,"lost client is destroyed rather than returned to the pool");
  await close();
  assert.equal(f.releaseCalls,1,"close after a connection error is idempotent");
});

test("normal LISTEN close unregisters notification and error handlers and releases once",async()=>{
  const f=fixture(),outbox=createTaskEventOutbox({pool:f.pool});
  const close=await outbox.listen(()=>{});
  await close();
  await close();
  assert.deepEqual(f.calls,["LISTEN jarvis_task_events","UNLISTEN jarvis_task_events"]);
  assert.equal(f.releaseCalls,1);
  assert.equal(f.releaseError,null);
  assert.equal(f.client.listenerCount("notification"),0);
  assert.equal(f.client.listenerCount("error"),0);
});

test("LISTEN setup failure destroys the checked-out client",async()=>{
  const f=fixture();
  f.client.query=async()=>{throw new Error("simulated LISTEN setup failure");};
  const outbox=createTaskEventOutbox({pool:f.pool});
  await assert.rejects(outbox.listen(()=>{}),/simulated LISTEN setup failure/);
  assert.equal(f.releaseCalls,1);
  assert.ok(f.releaseError);
  assert.equal(f.client.listenerCount("error"),0);
});
