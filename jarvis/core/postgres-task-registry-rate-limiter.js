"use strict";
const crypto=require("node:crypto");
const TYPES=new Set(["agent","project","conversation","worker","operation"]);
const DEFAULT_LIMITS=Object.freeze({agent:120,project:600,conversation:120,worker:120,operation:600});
function digest(value){return crypto.createHash("sha256").update(String(value)).digest("hex");}
function createPostgresTaskRegistryRateLimiter({pool,limits=DEFAULT_LIMITS,windowMs=60000,clock=()=>new Date()}={}){
  if(!pool||typeof pool.connect!=="function")throw new Error("PostgreSQL pool is required");
  if(!Number.isInteger(windowMs)||windowMs<1000||windowMs>3600000)throw new Error("Invalid shared rate limit window");
  const configured={...DEFAULT_LIMITS,...limits};
  for(const type of TYPES)if(!Number.isInteger(configured[type])||configured[type]<1||configured[type]>100000)throw new Error("Invalid shared rate limit for "+type);
  async function consume(agentId,context={}){
    if(typeof agentId!=="string"||!agentId.trim()||agentId.length>128)throw new Error("Valid agent ID is required for shared rate limiting");
    const scopes=[["agent",agentId]];
    for(const projectId of [...new Set(Array.isArray(context.projectIds)?context.projectIds:[])])scopes.push(["project",projectId]);
    scopes.push(["conversation",context.conversationId||"agent:"+agentId]);
    scopes.push(["worker",context.workerId||agentId]);
    scopes.push(["operation",context.operation||"unknown"]);
    const nowValue=clock();
    const now=new Date(nowValue).toISOString();
    if(!Number.isFinite(Date.parse(now)))throw new Error("Shared rate limiter clock is invalid");
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      let retryAfter=0;
      for(const [type,value] of scopes){
        const key=digest(value);
        const result=await client.query(
          "INSERT INTO jarvis.api_rate_limit_buckets(scope_type,scope_key,window_started_at,request_count,updated_at) VALUES($1,$2,$3,1,$3) ON CONFLICT(scope_type,scope_key) DO UPDATE SET request_count=CASE WHEN jarvis.api_rate_limit_buckets.window_started_at+($4::int*interval '1 millisecond')<=$3::timestamptz THEN 1 ELSE jarvis.api_rate_limit_buckets.request_count+1 END,window_started_at=CASE WHEN jarvis.api_rate_limit_buckets.window_started_at+($4::int*interval '1 millisecond')<=$3::timestamptz THEN $3::timestamptz ELSE jarvis.api_rate_limit_buckets.window_started_at END,updated_at=$3::timestamptz RETURNING window_started_at,request_count",
          [type,key,now,windowMs]
        );
        const row=result.rows[0];
        if(Number(row.request_count)>configured[type]){
          const resetAt=Date.parse(row.window_started_at)+windowMs;
          retryAfter=Math.max(retryAfter,Math.max(1,Math.ceil((resetAt-Date.parse(now))/1000)));
        }
      }
      await client.query("COMMIT");
      return {allowed:retryAfter===0,retryAfter};
    }catch(error){
      try{await client.query("ROLLBACK");}catch{}
      throw error;
    }finally{client.release();}
  }
  return {consume};
}
module.exports={createPostgresTaskRegistryRateLimiter,DEFAULT_LIMITS};
