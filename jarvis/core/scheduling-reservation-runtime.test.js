"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createSchedulingReservationRuntime}=require("./scheduling-reservation-runtime");

test("runtime composes PostgreSQL store and reservation agent and checks migration 0006",async()=>{
  const calls=[];
  const pool={
    async query(sql){calls.push(sql);return{rows:[{events:"jarvis.events",migration:true}]};},
    async connect(){throw new Error("not used by init");}
  };
  const calendar={async listEvents(){return[];}};
  const booking={supportsIdempotency:true,async searchAvailability(){return[];},async createReservation(){return{confirmed:true,reservationId:"test"};}};
  const taskRegistry={async createTask(input){return{created:true,task:input};}};
  const authorizeApproval=async()=>({approved:false});
  const runtime=createSchedulingReservationRuntime({pool,calendar,booking,taskRegistry,authorizeApproval});
  assert.equal(typeof runtime.agent.propose,"function");
  assert.equal(typeof runtime.agent.confirmReservation,"function");
  assert.equal(typeof runtime.agent.reconcileReservation,"function");
  assert.deepEqual(await runtime.init(),{ok:true,storage:"postgresql",migration:"0006_scheduling_reservation_store"});
  assert.equal(calls.length,1);
  assert.match(calls[0],/0006_scheduling_reservation_store/);
  await runtime.init();
  assert.equal(calls.length,1,"successful initialization is cached");
});

test("runtime fails closed when migration 0006 is absent",async()=>{
  const pool={async query(){return{rows:[{events:"jarvis.events",migration:false}]};},async connect(){throw new Error("not used");}};
  const runtime=createSchedulingReservationRuntime({
    pool,
    calendar:{async listEvents(){return[];}},
    booking:{supportsIdempotency:true,async searchAvailability(){return[];},async createReservation(){return{confirmed:true,reservationId:"test"};}},
    taskRegistry:{async createTask(){return{created:true};}},
    authorizeApproval:async()=>({approved:false})
  });
  await assert.rejects(runtime.init(),/migration 0006 is not installed/);
});
