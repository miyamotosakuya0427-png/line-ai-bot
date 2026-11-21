"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createServer}=require("./server");

const API_TOKEN="a".repeat(40);
const REGISTRY_TOKEN="b".repeat(40);
const principal={agentId:"agent-a",conversationId:"conversation-a",projectIds:["project-a"],scopes:["tasks:read"]};

async function startServer(options){
  const server=createServer({token:API_TOKEN,ownerToken:"c".repeat(40),taskRegistry:{},authorizeTaskRegistry:options.authorizeTaskRegistry,
    taskRegistryRateLimiter:{async consume(){return {allowed:true};}},executionKernel:{},taskEventOutbox:options.outbox,taskRegistryRevocationStore:options.revocationStore===false?null:(options.revocationStore||{async isRevoked(){return false;}})});
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  return {server,url:"http://127.0.0.1:"+server.address().port+"/v1/command-center/events?projectId=project-a&conversationId=conversation-a"};
}
async function closeServer(server){await new Promise(resolve=>server.close(resolve));}

test("Command Center SSE replays scoped events and excludes sensitive payload fields",async()=>{
  let replayCalls=0,listenerClosed=0;
  const event={cursor:7,eventId:44,taskId:"task-1",version:3,eventType:"claimed",createdAt:"2026-11-21T10:00:00.000Z",payload:{ownerAgent:"agent-a",projectId:"project-a",ownerConversation:"conversation-a",leaseTokenHash:"must-not-leak",secret:"must-not-leak"}};
  const outbox={
    async replay(args){assert.equal(args.projectId,"project-a");assert.equal(args.conversationId,"conversation-a");replayCalls++;assert.equal(args.afterCursor,replayCalls===1?6:7);return replayCalls===1?[{...event,cursor:6},event]:[];},
    async listen(onWake){return async()=>{listenerClosed++;};}
  };
  const {server,url}=await startServer({outbox,authorizeTaskRegistry:async req=>{
    assert.equal(req.headers.authorization,"Bearer "+REGISTRY_TOKEN);return principal;
  }});
  const controller=new AbortController();
  try{
    const response=await fetch(url,{headers:{Authorization:"Bearer "+API_TOKEN,"X-Task-Registry-Authorization":"Bearer "+REGISTRY_TOKEN,"Last-Event-ID":"6"},signal:controller.signal});
    assert.equal(response.status,200);
    assert.match(response.headers.get("content-type"),/text\/event-stream/);
    const reader=response.body.getReader();let body="";
    while(!body.includes("event: task")){const part=await reader.read();if(part.done)break;body+=new TextDecoder().decode(part.value);}
    assert.match(body,/id: 7/);
    assert.doesNotMatch(body,/id: 6/);
    assert.match(body,/"taskId":"task-1"/);
    assert.doesNotMatch(body,/must-not-leak|leaseTokenHash|secret/);
    controller.abort();
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(listenerClosed,1,"disconnect must release the PostgreSQL listener");
  }finally{controller.abort();await closeServer(server);}
});

test("Command Center SSE closes when Task Registry authorization is revoked during connection",async()=>{
  let authCalls=0,listenerClosed=0;
  const outbox={async replay(){return [];},async listen(){return async()=>{listenerClosed++;};}};
  const {server,url}=await startServer({outbox,authorizeTaskRegistry:async()=>++authCalls===1?principal:null});
  try{
    const response=await fetch(url,{headers:{Authorization:"Bearer "+API_TOKEN,"X-Task-Registry-Authorization":"Bearer "+REGISTRY_TOKEN}});
    assert.equal(response.status,200);
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.ok(authCalls>=2,"authorization must be checked again after the stream opens");
    await response.body.cancel();
    assert.equal(listenerClosed,1);
  }finally{await closeServer(server);}
});

test("Command Center SSE rejects Project and Conversation scope escalation",async()=>{
  const outbox={async replay(){throw new Error("must not query outbox for unauthorized scope");},async listen(){throw new Error("must not listen for unauthorized scope");}};
  const {server,url}=await startServer({outbox,authorizeTaskRegistry:async()=>principal});
  try{
    const response=await fetch(url.replace("project-a","project-b"),{headers:{Authorization:"Bearer "+API_TOKEN,"X-Task-Registry-Authorization":"Bearer "+REGISTRY_TOKEN}});
    assert.equal(response.status,403);
    const conversation=await fetch(url.replace("conversation-a","conversation-b"),{headers:{Authorization:"Bearer "+API_TOKEN,"X-Task-Registry-Authorization":"Bearer "+REGISTRY_TOKEN}});
    assert.equal(conversation.status,403);
  }finally{await closeServer(server);}
});

test("Command Center SSE fails closed when shared revocation checks are unavailable",async()=>{
 const outbox={async replay(){throw new Error("must not replay");},async listen(){throw new Error("must not listen");}};
 const {server,url}=await startServer({outbox,revocationStore:false,authorizeTaskRegistry:async()=>principal});
 try{
  const response=await fetch(url,{headers:{Authorization:"Bearer "+API_TOKEN,"X-Task-Registry-Authorization":"Bearer "+REGISTRY_TOKEN}});
  assert.equal(response.status,503);
 }finally{await closeServer(server);}
});
