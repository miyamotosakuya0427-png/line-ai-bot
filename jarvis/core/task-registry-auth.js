"use strict";
const crypto=require("node:crypto");
const ALLOWED_SCOPES=new Set(["tasks:read","tasks:write","tasks:dispatch","tasks:claim","tasks:lease","tasks:transition","resources:lease"]);
const AGENT_ID=/^[A-Za-z0-9._:-]{1,128}$/;
function createTaskRegistryAuthorizer({config=process.env.JARVIS_TASK_REGISTRY_AGENT_TOKENS}={}){
  if(typeof config!=="string"||!config.trim())throw new Error("Task Registry agent token configuration is required");
  let parsed;
  try{parsed=JSON.parse(config);}catch{throw new Error("Task Registry agent token configuration is invalid");}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.keys(parsed).length<1||Object.keys(parsed).length>100)throw new Error("Task Registry agent token configuration is invalid");
  const agents=[];
  const seen=new Set();
  for(const [agentId,value] of Object.entries(parsed)){
    if(!AGENT_ID.test(agentId)||!value||typeof value!=="object"||Array.isArray(value)||typeof value.tokenHash!=="string"||!/^[a-f0-9]{64}$/i.test(value.tokenHash)||!Array.isArray(value.scopes)||value.scopes.length<1||value.scopes.length>ALLOWED_SCOPES.size||value.scopes.some(scope=>!ALLOWED_SCOPES.has(scope))||new Set(value.scopes).size!==value.scopes.length)throw new Error("Task Registry agent entry is invalid");
    const tokenHash=value.tokenHash.toLowerCase();
    if(seen.has(tokenHash))throw new Error("Task Registry agent token hashes must be unique");
    seen.add(tokenHash);
    const conversationId=value.conversationId===undefined?null:value.conversationId;
    if(conversationId!==null&&(typeof conversationId!=="string"||!conversationId.trim()||conversationId.length>128))throw new Error("Task Registry conversation identity is invalid");
    agents.push({agentId,tokenHash,scopes:[...value.scopes],conversationId});
  }
  return async function authorizeTaskRegistryAgent(req){
    const match=/^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(req?.headers?.authorization||"");
    if(!match)return null;
    const supplied=crypto.createHash("sha256").update(match[1],"utf8").digest();
    for(const agent of agents){
      const expected=Buffer.from(agent.tokenHash,"hex");
      if(supplied.length===expected.length&&crypto.timingSafeEqual(supplied,expected)){
        return {agentId:agent.agentId,conversationId:agent.conversationId,scopes:[...agent.scopes]};
      }
    }
    return null;
  };
}
module.exports={ALLOWED_SCOPES,createTaskRegistryAuthorizer};
