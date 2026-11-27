"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createServer}=require("./server");
const OWNER="d".repeat(40);
test("shared Agent token revocation is Owner-only and requires explicit approval",async()=>{
  const revoked=[];
  const server=createServer({ownerToken:OWNER,taskRegistryRevocationStore:{async revoke(input){revoked.push(input);return{revoked:true,agentId:input.agentId};}}});
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  try{
    const url="http://127.0.0.1:"+server.address().port+"/v1/admin/task-registry-agents/agent-a/revoke";
    const denied=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ownerApproval:true})});
    assert.equal(denied.status,401);assert.equal(revoked.length,0);
    const headers={Authorization:"Bearer "+OWNER,"Content-Type":"application/json"};
    const approvalRequired=await fetch(url,{method:"POST",headers,body:JSON.stringify({})});
    assert.equal(approvalRequired.status,403);assert.equal(revoked.length,0);
    const accepted=await fetch(url,{method:"POST",headers,body:JSON.stringify({ownerApproval:true})});
    assert.equal(accepted.status,201);assert.equal(revoked.length,1);assert.equal(revoked[0].agentId,"agent-a");
  }finally{await new Promise(resolve=>server.close(resolve));}
});
