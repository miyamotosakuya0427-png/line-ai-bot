"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createTaskRegistry,TASK_STATES}=require("./task-registry-store");

test("exports the defined task lifecycle",()=>{
  assert.deepEqual([...TASK_STATES].sort(),["blocked","cancelled","claimed","completed","in_progress","proposed","ready","review","verified"].sort());
});
test("requires PostgreSQL; no JSONL or in-memory lock fallback",()=>{
  assert.throws(()=>createTaskRegistry(),/PostgreSQL pool is required/);
  assert.throws(()=>createTaskRegistry({pool:{query:async()=>({rows:[]})}}),/PostgreSQL pool is required/);
});
test("fails closed when migration 0004 is missing",async()=>{
  const pool={connect:async()=>({query:async()=>({rows:[]}),release(){}}),query:async()=>({rows:[{events:"jarvis.events",leases:null}]})};
  const registry=createTaskRegistry({pool});
  await assert.rejects(registry.init(),/migration 0004 is not installed/);
});
test("rejects invalid task payload before database writes",async()=>{
  const pool={connect:async()=>{throw new Error("unexpected database access");},query:async()=>({rows:[{events:"jarvis.events",leases:"jarvis.coordination_leases"}]})};
  const registry=createTaskRegistry({pool});
  await registry.init();
  await assert.rejects(registry.createTask({title:"",dedupeKey:"key"}),/Invalid task input/);
});
