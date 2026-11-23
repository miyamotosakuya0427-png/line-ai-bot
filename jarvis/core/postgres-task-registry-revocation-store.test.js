"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {createTaskRegistryAuthorizer}=require("./task-registry-auth");
const {createPostgresTaskRegistryRevocationStore}=require("./postgres-task-registry-revocation-store");
const token="live-revocation-test-token".padEnd(48,"x");
const tokenHash=crypto.createHash("sha256").update(token).digest("hex");
test("shared Agent revocation is re-read for every request without process restart",async()=>{
  let revoked=false,reads=0;
  const store={async isRevoked(agentId){reads++;assert.equal(agentId,"agent-live");return revoked;}};
  const authorize=createTaskRegistryAuthorizer({config:JSON.stringify({"agent-live":{tokenHash,expiresAt:"2099-01-01T00:00:00.000Z",scopes:["tasks:read"],projectIds:["one-jarvis"]}}),revocationStore:store});
  const req={headers:{authorization:"Bearer "+token}};
  assert.equal((await authorize(req)).agentId,"agent-live");
  revoked=true;
  assert.equal(await authorize(req),null);
  assert.equal(reads,2);
});
test("PostgreSQL revocation store fails closed when migration is absent and records revocations once",async()=>{
  let exists=false;const rows=new Set();
  const query=async(sql,args=[])=>{
    if(sql.includes("to_regclass"))return{rows:[{table_name:exists?"jarvis.task_registry_agent_revocations":null}]};
    if(sql.includes("INSERT INTO jarvis.task_registry_agent_revocations")){const before=rows.size;rows.add(args[0]);return{rowCount:rows.size-before,rows:[]};}
    if(sql.includes("SELECT 1 FROM jarvis.task_registry_agent_revocations"))return{rowCount:rows.has(args[0])?1:0,rows:[]};
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("pg_advisory_xact_lock"))return{rowCount:0,rows:[]};
    throw new Error("unexpected query: "+sql);
  };
  const pool={query,async connect(){return{query,release(){}};}};
  const store=createPostgresTaskRegistryRevocationStore({pool,clock:()=>"2026-11-21T00:00:00.000Z"});
  await assert.rejects(store.init(),/migration 0010 is not installed/);
  exists=true;await store.init();
  assert.equal((await store.revoke({agentId:"agent-live",revokedBy:"owner-token"})).revoked,true);
  assert.equal((await store.revoke({agentId:"agent-live",revokedBy:"owner-token"})).revoked,false);
  assert.equal(await store.isRevoked("agent-live"),true);
});
