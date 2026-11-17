"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {createTaskRegistryAuthorizer}=require("./task-registry-auth");
function hash(token){return crypto.createHash("sha256").update(token).digest("hex");}
test("agent authorization maps opaque bearer tokens to scoped principals without storing raw tokens",async()=>{
  const token="agent-token-".padEnd(48,"x");
  const authorize=createTaskRegistryAuthorizer({config:JSON.stringify({
    "worker-a":{tokenHash:hash(token),conversationId:"conversation-a",scopes:["tasks:read","tasks:claim","tasks:lease"]}
  })});
  const principal=await authorize({headers:{authorization:"Bearer "+token}});
  assert.deepEqual(principal,{agentId:"worker-a",conversationId:"conversation-a",scopes:["tasks:read","tasks:claim","tasks:lease"]});
  assert.equal(JSON.stringify(principal).includes(token),false);
});
test("invalid, missing, or unknown tokens fail closed",async()=>{
  assert.throws(()=>createTaskRegistryAuthorizer({config:""}),/configuration is required/);
  const authorize=createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash("a".repeat(40)),scopes:["tasks:read"]}})});
  assert.equal(await authorize({headers:{authorization:"Bearer "+"b".repeat(40)}}),null);
  assert.equal(await authorize({headers:{authorization:"Basic "+"a".repeat(40)}}),null);
});
test("invalid scopes, duplicate token hashes, and malformed configuration are rejected",()=>{
  assert.throws(()=>createTaskRegistryAuthorizer({config:"{"}),/configuration is invalid/);
  assert.throws(()=>createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash("a".repeat(40)),scopes:["admin"]}})}),/entry is invalid/);
  const same=hash("a".repeat(40));
  assert.throws(()=>createTaskRegistryAuthorizer({config:JSON.stringify({
    "worker-a":{tokenHash:same,scopes:["tasks:read"]},
    "worker-b":{tokenHash:same,scopes:["tasks:read"]}
  })}),/must be unique/);
});
test("agent authorization rejects malformed conversation identities",()=>{
  assert.throws(()=>createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash("a".repeat(40)),conversationId:7,scopes:["tasks:read"]}})}),/conversation identity is invalid/);
});
