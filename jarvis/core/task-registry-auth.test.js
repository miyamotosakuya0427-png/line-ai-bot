"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {createTaskRegistryAuthorizer}=require("./task-registry-auth");
function hash(token){return crypto.createHash("sha256").update(token).digest("hex");}
test("agent authorization maps opaque bearer tokens to scoped principals without storing raw tokens",async()=>{
  const token="agent-token-".padEnd(48,"x");
  const authorize=createTaskRegistryAuthorizer({config:JSON.stringify({
    "worker-a":{tokenHash:hash(token),expiresAt:"2099-01-01T00:00:00.000Z",conversationId:"conversation-a",scopes:["tasks:read","tasks:claim","tasks:lease"],projectIds:["one-jarvis","video"],resourcePrefixes:["branch:one-jarvis:","path:video:"]}
  }),revocationStore:{async isRevoked(){return false;}}});
  const principal=await authorize({headers:{authorization:"Bearer "+token}});
  assert.deepEqual(principal,{agentId:"worker-a",conversationId:"conversation-a",scopes:["tasks:read","tasks:claim","tasks:lease"],projectIds:["one-jarvis","video"],resourcePrefixes:["branch:one-jarvis:","path:video:"]});
  assert.equal(JSON.stringify(principal).includes(token),false);
});
test("invalid, missing, or unknown tokens fail closed",async()=>{
  assert.throws(()=>createTaskRegistryAuthorizer({config:""}),/configuration is required/);
  const authorize=createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash("a".repeat(40)),expiresAt:"2099-01-01T00:00:00.000Z",scopes:["tasks:read"]}})});
  assert.equal(await authorize({headers:{authorization:"Bearer "+"b".repeat(40)}}),null);
  assert.equal(await authorize({headers:{authorization:"Basic "+"a".repeat(40)}}),null);
});
test("invalid scopes, duplicate token hashes, and malformed configuration are rejected",()=>{
  assert.throws(()=>createTaskRegistryAuthorizer({config:"{"}),/configuration is invalid/);
  assert.throws(()=>createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash("a".repeat(40)),expiresAt:"2099-01-01T00:00:00.000Z",scopes:["admin"]}})}),/entry is invalid/);
  const same=hash("a".repeat(40));
  assert.throws(()=>createTaskRegistryAuthorizer({config:JSON.stringify({
    "worker-a":{tokenHash:same,expiresAt:"2099-01-01T00:00:00.000Z",scopes:["tasks:read"]},
    "worker-b":{tokenHash:same,expiresAt:"2099-01-01T00:00:00.000Z",scopes:["tasks:read"]}
  })}),/must be unique/);
});
test("agent authorization rejects malformed conversation identities",()=>{
  assert.throws(()=>createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash("a".repeat(40)),expiresAt:"2099-01-01T00:00:00.000Z",conversationId:7,scopes:["tasks:read"]}})}),/conversation identity is invalid/);
});

test("resource lease capability requires explicit resource prefixes",()=>{
  const token="z".repeat(40);
  assert.throws(()=>createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash(token),expiresAt:"2099-01-01T00:00:00.000Z",scopes:["resources:lease"]}})}),/requires explicit resource prefixes/);
  assert.throws(()=>createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash(token),expiresAt:"2099-01-01T00:00:00.000Z",scopes:["tasks:read"],resourcePrefixes:["path:other-project"]}})}),/resource scope is invalid/);
});

test("expired and revoked bearer tokens are rejected at request time",async()=>{
  const token="expiring-agent-token".padEnd(48,"x");
  const config=JSON.stringify({
    "expired-agent":{tokenHash:hash(token),expiresAt:"2026-01-01T00:00:00.000Z",scopes:["tasks:read"]},
    "revoked-agent":{tokenHash:hash("revoked-agent-token".padEnd(48,"x")),expiresAt:"2099-01-01T00:00:00.000Z",revoked:true,scopes:["tasks:read"]}
  });
  const authorize=createTaskRegistryAuthorizer({config,clock:()=>Date.parse("2026-11-17T00:00:00.000Z")});
  assert.equal(await authorize({headers:{authorization:"Bearer "+token}}),null);
  assert.equal(await authorize({headers:{authorization:"Bearer "+"revoked-agent-token".padEnd(48,"x")}}),null);
});

test("missing or malformed token expiry fails closed at configuration time",()=>{
  const token="expiry-required".padEnd(48,"x");
  assert.throws(()=>createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash(token),scopes:["tasks:read"]}})}),/agent entry is invalid/);
  assert.throws(()=>createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash(token),expiresAt:"not-a-date",scopes:["tasks:read"]}})}),/agent entry is invalid/);
});

test("internal target Agent authorization rechecks expiry, project, conversation, scopes and shared revocation",async()=>{
 const token="target-agent-token".padEnd(48,"x");
 let revoked=false;
 const authorize=createTaskRegistryAuthorizer({
  config:JSON.stringify({"target-agent":{tokenHash:hash(token),expiresAt:"2099-01-01T00:00:00.000Z",conversationId:"conversation-a",projectIds:["project-a"],scopes:["tasks:dispatch","tasks:claim"]}}),
  revocationStore:{async isRevoked(){return revoked;}}
 });
 const principal=await authorize.authorizeAgent("target-agent",{projectId:"project-a",conversationId:"conversation-a",requiredScopes:["tasks:dispatch","tasks:claim"]});
 assert.equal(principal.agentId,"target-agent");
 assert.equal(await authorize.authorizeAgent("target-agent",{projectId:"other",conversationId:"conversation-a"}),null);
 assert.equal(await authorize.authorizeAgent("target-agent",{projectId:"project-a",conversationId:"other"}),null);
 assert.equal(await authorize.authorizeAgent("target-agent",{projectId:"project-a",conversationId:"conversation-a",requiredScopes:["tasks:write"]}),null);
 revoked=true;
 assert.equal(await authorize.authorizeAgent("target-agent",{projectId:"project-a",conversationId:"conversation-a"}),null);
});
test("internal target Agent authorization fails closed without the shared revocation store",async()=>{
 const token="target-agent-token".padEnd(48,"x");
 const authorize=createTaskRegistryAuthorizer({config:JSON.stringify({"target-agent":{tokenHash:hash(token),expiresAt:"2099-01-01T00:00:00.000Z",conversationId:"conversation-a",scopes:["tasks:dispatch","tasks:claim"]}})});
 await assert.rejects(()=>authorize.authorizeAgent("target-agent",{projectId:"one-jarvis",conversationId:"conversation-a"}),/Shared Task Registry revocation store/);
});

test("Claim and Dispatch scopes fail closed when shared revocation storage is unavailable",async()=>{
 const token="claim-needs-revocation".padEnd(48,"x");
 const authorize=createTaskRegistryAuthorizer({config:JSON.stringify({"worker-a":{tokenHash:hash(token),expiresAt:"2099-01-01T00:00:00.000Z",scopes:["tasks:claim","tasks:dispatch"]}})});
 assert.equal((await authorize({headers:{authorization:"Bearer "+token}},{action:"list"})).agentId,"worker-a","read-only polling remains available");\n await assert.rejects(()=>authorize({headers:{authorization:"Bearer "+token}},{action:"claim"}),/Shared Task Registry revocation store is required/);
});
