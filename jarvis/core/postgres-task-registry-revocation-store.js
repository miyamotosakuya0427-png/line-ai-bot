"use strict";
function createPostgresTaskRegistryRevocationStore({pool,clock=()=>new Date().toISOString()}={}){
  if(!pool||typeof pool.query!=="function")throw new Error("PostgreSQL pool is required");
  return {
    async init(){
      const r=await pool.query("SELECT to_regclass('jarvis.task_registry_agent_revocations') AS table_name");
      if(!r.rows[0]?.table_name)throw new Error("Task Registry revocation migration 0010 is not installed");
      return {ok:true};
    },
    async isRevoked(agentId){
      if(typeof agentId!=="string"||! /^[A-Za-z0-9._:-]{1,128}$/.test(agentId))throw new Error("Invalid Agent ID");
      const r=await pool.query("SELECT 1 FROM jarvis.task_registry_agent_revocations WHERE agent_id=$1",[agentId]);
      return r.rowCount>0;
    },
    async revoke({agentId,revokedBy}={}){
      if(typeof agentId!=="string"||! /^[A-Za-z0-9._:-]{1,128}$/.test(agentId)||typeof revokedBy!=="string"||!revokedBy.trim()||revokedBy.length>128)throw new Error("Invalid Agent revocation");
      const r=await pool.query("INSERT INTO jarvis.task_registry_agent_revocations(agent_id,revoked_at,revoked_by) VALUES($1,$2,$3) ON CONFLICT(agent_id) DO NOTHING RETURNING agent_id,revoked_at,revoked_by",[agentId,clock(),revokedBy]);
      return {revoked:r.rowCount===1,agentId};
    }
  };
}
module.exports={createPostgresTaskRegistryRevocationStore};
