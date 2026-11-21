"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createServer}=require("./server");
const OWNER="c".repeat(40);
const grantId="123e4567-e89b-42d3-a456-426614174000";

async function withServer(executionKernel,run){
  const server=createServer({ownerToken:OWNER,executionKernel});
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  try{return await run("http://127.0.0.1:"+server.address().port);}
  finally{await new Promise(resolve=>server.close(resolve));}
}
test("Worker Grant audit listing is Owner-only and strips credential material",async()=>{
  await withServer({async listWorkerScopeGrants(){return [{grant_id:grantId,worker_id:"worker-a",agent_id:"agent-a",department_id:"engineering",project_id:"project-a",conversation_id:"conversation-a",granted_by:"owner-token",granted_at:"2026-11-21T00:00:00Z",revoked_by:null,revoked_at:null,grant_version:1,worker_status:"idle",current_task_id:null,heartbeat_at:null,lease_expires_at:null,token_hash:"secret-hash",lease_token:"secret"}];}},async grantWorkerScope(){},async revokeWorkerScope(){}},async base=>{
    const denied=await fetch(base+"/v1/admin/worker-scope-grants");
    assert.equal(denied.status,401);
    const response=await fetch(base+"/v1/admin/worker-scope-grants",{headers:{Authorization:"Bearer "+OWNER}});
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.grants[0].workerId,"worker-a");
    assert.doesNotMatch(JSON.stringify(data),/secret-hash|lease_token|token_hash/);
  });
});
test("Worker Grant create and revoke require Owner authentication and explicit approval",async()=>{
  let created=0,revoked=0;
  await withServer({
    async listWorkerScopeGrants(){return [];},
    async grantWorkerScope(input){created++;assert.equal(input.grantedBy,"owner-token");return {created:true,grantId};},
    async revokeWorkerScope(input){revoked++;assert.equal(input.revokedBy,"owner-token");return {revoked:true,grantId};}
  },async base=>{
    const headers={"Content-Type":"application/json",Authorization:"Bearer "+OWNER};
    const noApproval=await fetch(base+"/v1/admin/workers/worker-a/scope-grants",{method:"POST",headers,body:JSON.stringify({projectId:"project-a",conversationId:"conversation-a"})});
    assert.equal(noApproval.status,403);assert.equal(created,0);
    const grant=await fetch(base+"/v1/admin/workers/worker-a/scope-grants",{method:"POST",headers,body:JSON.stringify({projectId:"project-a",conversationId:"conversation-a",ownerApproval:true})});
    assert.equal(grant.status,201);assert.equal(created,1);
    const revokeNoApproval=await fetch(base+"/v1/admin/worker-scope-grants/"+grantId+"/revoke",{method:"POST",headers,body:JSON.stringify({})});
    assert.equal(revokeNoApproval.status,403);assert.equal(revoked,0);
    const revoke=await fetch(base+"/v1/admin/worker-scope-grants/"+grantId+"/revoke",{method:"POST",headers,body:JSON.stringify({ownerApproval:true})});
    assert.equal(revoke.status,200);assert.equal(revoked,1);
  });
});
