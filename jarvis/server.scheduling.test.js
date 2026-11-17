"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createServer}=require("./server");

async function withServer(app,fn){
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  try{return await fn("http://127.0.0.1:"+app.address().port);}
  finally{await new Promise(resolve=>app.close(resolve));}
}
const ownerToken="o".repeat(64);

test("reservation routes require owner authentication and explicit runtime injection",async()=>{
  const app=createServer({token:"t".repeat(64),ownerToken});
  await withServer(app,async base=>{
    const denied=await fetch(base+"/v1/reservations/propose",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:"test"})});
    assert.equal(denied.status,401);
    const unavailable=await fetch(base+"/v1/reservations/propose",{method:"POST",headers:{Authorization:"Bearer "+ownerToken,"Content-Type":"application/json"},body:JSON.stringify({title:"test"})});
    assert.equal(unavailable.status,503);
  });
});

test("reservation routes initialize injected runtime once and dispatch proposal, confirmation and reconciliation",async()=>{
  const calls=[];
  const runtime={
    async init(){calls.push("init");},
    agent:{
      async propose(input){calls.push(["propose",input]);return{record:{id:"r-1",state:"proposed"},canConfirm:true};},
      async confirmReservation(input){calls.push(["confirm",input]);return{record:{id:input.id,state:"confirmed"}};},
      async reconcileReservation(input){calls.push(["reconcile",input]);return{record:{id:input.id,state:"outcome_unknown"},changed:false};}
    }
  };
  const app=createServer({token:"t".repeat(64),ownerToken,schedulingRuntime:runtime});
  await withServer(app,async base=>{
    const post=async(path,body)=>fetch(base+path,{method:"POST",headers:{Authorization:"Bearer "+ownerToken,"Content-Type":"application/json"},body:JSON.stringify(body)});
    const proposal=await post("/v1/reservations/propose",{title:"test reservation"});
    assert.equal(proposal.status,201);
    assert.equal((await proposal.json()).record.id,"r-1");
    const missingApproval=await post("/v1/reservations/confirm",{id:"r-1"});
    assert.equal(missingApproval.status,400);
    const confirmed=await post("/v1/reservations/confirm",{id:"r-1",approval:{approvalId:"a-1"}});
    assert.equal(confirmed.status,200);
    const reconciled=await post("/v1/reservations/reconcile",{id:"r-1"});
    assert.equal(reconciled.status,200);
    assert.equal(calls.filter(x=>x==="init").length,1);
    assert.deepEqual(calls.filter(x=>Array.isArray(x)).map(x=>x[0]),["propose","confirm","reconcile"]);
  });
});
