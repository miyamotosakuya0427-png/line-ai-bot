"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createSchedulingReservationAgent}=require("./scheduling-reservation-agent");
function fixture({conflict=false,bookingOverride={}}={}){
 const records=new Map();let creates=0;
 const store={async create(r){records.set(r.id,r);return r;},async get(id){return records.get(id)||null;},async update(id,r){records.set(id,r);return r;}};
 const calendar={async listEvents(){return conflict?[{id:"busy",start:"2026-11-18T10:00:00+09:00",end:"2026-11-18T11:00:00+09:00"}]:[];}};
 const booking={supportsIdempotency:true,async searchAvailability(){return[{start:"2026-11-18T10:00:00+09:00"}];},async createReservation(){creates++;return{confirmed:true,reservationId:"R-1"};},...bookingOverride};
 const taskRegistry={async createTask(input){return{created:true,task:{title:input.title}};}};
 const authorizeApproval=async(a,ctx)=>a?.operationHash===ctx.operationHash?{approved:true,approvalId:"approval-1",operationHash:ctx.operationHash}:null;
 return{agent:createSchedulingReservationAgent({calendar,booking,store,taskRegistry,authorizeApproval}),records,booking,store,get creates(){return creates;}};
}
const input={title:"打合せ予約",provider:"Example Provider",start:"2026-11-18T10:00:00+09:00",end:"2026-11-18T11:00:00+09:00",partySize:2};
test("reservation proposal checks calendar conflicts and never books",async()=>{
 const f=fixture({conflict:true});const p=await f.agent.propose(input);
 assert.equal(p.record.state,"proposed");assert.equal(p.canConfirm,false);assert.equal(f.creates,0);
});
test("reservation create requires approval bound to immutable proposal",async()=>{
 const f=fixture();const p=await f.agent.propose(input);
 await assert.rejects(f.agent.confirmReservation({id:p.record.id,approval:{approved:true}}),/explicit approval/);
 assert.equal(f.creates,0);
});
test("approved reservation uses stable idempotency key and stores confirmed reference",async()=>{
 const f=fixture();const p=await f.agent.propose(input);
 const approval={operationHash:p.record.operationHash};
 const done=await f.agent.confirmReservation({id:p.record.id,approval});
 assert.equal(done.record.state,"confirmed");assert.equal(done.record.reservationId,"R-1");assert.equal(f.creates,1);
 const duplicate=await f.agent.confirmReservation({id:p.record.id,approval});
 assert.equal(duplicate.duplicate,true);assert.equal(f.creates,1);
});
test("ambiguous provider outcome is not retried and remains outcome_unknown",async()=>{
 const f=fixture({bookingOverride:{async createReservation(){throw Object.assign(new Error("timeout"),{requestStarted:true});}}});
 const p=await f.agent.propose(input);const done=await f.agent.confirmReservation({id:p.record.id,approval:{operationHash:p.record.operationHash}});
 assert.equal(done.record.state,"outcome_unknown");assert.equal(done.requiresReconciliation,true);
 const again=await f.agent.confirmReservation({id:p.record.id,approval:{operationHash:p.record.operationHash}});
 assert.equal(again.requiresReconciliation,true);assert.equal(f.creates,0);
});
test("provider without idempotency support fails closed",async()=>{
 const f=fixture({bookingOverride:{supportsIdempotency:false}});const p=await f.agent.propose(input);
 await assert.rejects(f.agent.confirmReservation({id:p.record.id,approval:{operationHash:p.record.operationHash}}),/fail closed/);
});
test("ambiguous booking is not auto-retried after provider says not found",async()=>{
 const f=fixture({bookingOverride:{async createReservation(){throw Object.assign(new Error("timeout"),{requestStarted:true});},async getReservationByIdempotencyKey(){return{status:"not_found"};}}});
 const p=await f.agent.propose(input);await f.agent.confirmReservation({id:p.record.id,approval:{operationHash:p.record.operationHash}});
 const result=await f.agent.reconcileReservation({id:p.record.id});assert.equal(result.changed,false);assert.match(result.blocked,/manual reconciliation/);
});
