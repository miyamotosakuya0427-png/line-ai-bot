"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createFencedResourceWriter}=require("./fenced-resource-writer");

test("fenced resource writer verifies the lease before crossing the adapter boundary",async()=>{
  let checks=0,writes=0;
  const registry={async assertLeaseCurrent({lease}){checks++;if(lease.token==="expired")throw new Error("Lease is expired, stale, or not owned by this caller");return true;}};
  const adapter={async writeFenced(){writes++;return{ok:true};}};
  const write=createFencedResourceWriter({registry,adapter});
  await assert.rejects(write({resourceKey:"path:repo:file.js",operationId:"op-1",payload:{x:1}}),/valid resource lease/);
  assert.equal(checks,0);
  await assert.rejects(write({lease:{resourceKey:"path:repo:file.js",ownerId:"worker",token:"expired",fencingToken:1,expiresAt:new Date(Date.now()+10000).toISOString()},resourceKey:"path:repo:file.js",operationId:"op-1",payload:{x:1}}),/expired, stale/);
  assert.equal(checks,1);
  assert.equal(writes,0);
});

test("fenced adapter contract rejects stale tokens and deduplicates operation IDs",async()=>{
  let now=Date.now();
  const registry={async assertLeaseCurrent({lease}){if(Date.parse(lease.expiresAt)<=now)throw new Error("Lease expired");}};
  const latest=new Map(),operations=new Map();
  const adapter={async writeFenced(input){
    if(Date.parse(input.leaseExpiresAt)<=now)throw new Error("Adapter rejected expired lease");
    const previous=latest.get(input.resourceKey)||0;
    if(input.fencingToken<previous)throw new Error("Stale fencing token");
    const key=input.resourceKey+":"+input.operationId;
    if(operations.has(key))return operations.get(key);
    latest.set(input.resourceKey,Math.max(previous,input.fencingToken));
    const result={ok:true,operationId:input.operationId,fencingToken:input.fencingToken};
    operations.set(key,result);return result;
  }};
  const write=createFencedResourceWriter({registry,adapter});
  const lease2={resourceKey:"branch:repo:main",ownerId:"worker-b",token:"token-b",fencingToken:2,expiresAt:new Date(now+10000).toISOString()};
  const first=await write({lease:lease2,resourceKey:lease2.resourceKey,operationId:"commit-1",payload:{sha:"abc"}});
  const duplicate=await write({lease:lease2,resourceKey:lease2.resourceKey,operationId:"commit-1",payload:{sha:"different"}});
  assert.deepEqual(duplicate,first,"retries with the same operation ID return the original result");
  const stale={...lease2,ownerId:"worker-a",token:"token-a",fencingToken:1};
  await assert.rejects(write({lease:stale,resourceKey:stale.resourceKey,operationId:"commit-2",payload:{sha:"def"}}),/Stale fencing token/);
  const expired={...lease2,expiresAt:new Date(now-1).toISOString()};
  await assert.rejects(write({lease:expired,resourceKey:expired.resourceKey,operationId:"commit-3",payload:{sha:"ghi"}}),/expired/);
});
