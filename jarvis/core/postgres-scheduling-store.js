"use strict";
const crypto=require("node:crypto");

const TRANSITIONS=Object.freeze({
  proposed:new Set(["approval_pending","failed"]),
  approval_pending:new Set(["confirmed","outcome_unknown","failed"]),
  outcome_unknown:new Set(["confirmed"]),
  confirmed:new Set([]),
  failed:new Set([]),
  cancel_pending:new Set(["cancelled","outcome_unknown"]),
  cancelled:new Set([])
});
function clone(v){return JSON.parse(JSON.stringify(v));}
function validText(v,max,required=true){return typeof v==="string"&&v.length<=max&&(!required||!!v.trim());}
function canonical(v){if(Array.isArray(v))return "["+v.map(canonical).join(",")+"]";if(v&&typeof v==="object")return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}";return JSON.stringify(v);}
function digest(v){return crypto.createHash("sha256").update(canonical(v)).digest("hex");}

function createPostgresSchedulingStore({pool,clock=()=>new Date().toISOString()}={}){
  if(!pool||typeof pool.connect!=="function"||typeof pool.query!=="function")throw new Error("PostgreSQL pool is required");
  let initialized=false;
  async function init(){
    if(initialized)return {ok:true};
    const r=await pool.query("SELECT to_regclass('jarvis.events') AS events, EXISTS(SELECT 1 FROM jarvis.schema_migrations WHERE version='0006_scheduling_reservation_store') AS migration");
    if(!r.rows[0]?.events||r.rows[0]?.migration!==true)throw new Error("Scheduling reservation migration 0006 is not installed");
    initialized=true;return {ok:true};
  }
  async function tx(fn){
    const c=await pool.connect();
    try{await c.query("BEGIN");const result=await fn(c);await c.query("COMMIT");return result;}
    catch(e){try{await c.query("ROLLBACK");}catch{}throw e;}
    finally{c.release();}
  }
  async function lock(c,key){await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[key]);}
  async function latest(c,id){
    const r=await c.query("SELECT aggregate_version,payload FROM jarvis.events WHERE aggregate_type='reservation' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[id]);
    return r.rows[0]?{version:Number(r.rows[0].aggregate_version),record:r.rows[0].payload}:null;
  }
  async function append(c,type,id,eventType,payload,idempotencyKey=null){
    const r=await c.query("SELECT COALESCE(MAX(aggregate_version),0)::bigint AS version FROM jarvis.events WHERE aggregate_type=$1 AND aggregate_id=$2",[type,id]);
    const version=Number(r.rows[0].version)+1;
    await c.query("INSERT INTO jarvis.events(aggregate_type,aggregate_id,aggregate_version,event_type,payload,idempotency_key,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",[type,id,version,eventType,JSON.stringify(payload),idempotencyKey,clock()]);
    return version;
  }
  async function audit(c,id,action,record,actor){
    await append(c,"reservation_audit",id,"reservation_"+action,{reservationId:id,action,actor:actor||"system",state:record.state,operationHash:record.operationHash,at:clock()});
  }
  return {
    async init(){await init();return {ok:true};},
    async create(record){
      await init();
      if(!record||record.type!=="reservation"||!validText(record.id,80)||!validText(record.operationHash,64)||!/^[a-f0-9]{64}$/.test(record.operationHash)||!validText(record.idempotencyKey,160)||record.state!=="proposed")throw new Error("Invalid reservation record");
      return tx(async c=>{
        await lock(c,"reservation-idempotency:"+record.idempotencyKey);
        const existing=await c.query("SELECT aggregate_id FROM jarvis.events WHERE aggregate_type='reservation' AND event_type='created' AND payload->>'idempotencyKey'=$1 LIMIT 1",[record.idempotencyKey]);
        if(existing.rows[0]){
          const current=await latest(c,existing.rows[0].aggregate_id);
          if(current?.record.operationHash!==record.operationHash)throw new Error("Reservation idempotency key conflict");
          return clone(current.record);
        }
        await lock(c,"reservation:"+record.id);
        await append(c,"reservation",record.id,"created",record,record.idempotencyKey);
        await audit(c,record.id,"created",record,record.createdBy||"system");
        return {...clone(record),version:1};
      });
    },
    async get(id){
      await init();
      const r=await pool.query("SELECT aggregate_version,payload FROM jarvis.events WHERE aggregate_type='reservation' AND aggregate_id=$1 ORDER BY aggregate_version DESC LIMIT 1",[id]);
      return r.rows[0]?{...clone(r.rows[0].payload),version:Number(r.rows[0].aggregate_version)}:null;
    },
    async update(id,patch){
      await init();
      if(!validText(id,80)||!patch||typeof patch!=="object"||Array.isArray(patch))throw new Error("Invalid reservation update");
      return tx(async c=>{
        await lock(c,"reservation:"+id);
        const current=await latest(c,id);
        if(!current)return null;
        const next={...current.record,...clone(patch)};
        if(!TRANSITIONS[current.record.state]?.has(next.state))throw new Error("Invalid reservation state transition or concurrent update");
        if(next.id!==id||next.operationHash!==current.record.operationHash||next.idempotencyKey!==current.record.idempotencyKey)throw new Error("Reservation immutable fields changed");
        const version=await append(c,"reservation",id,"state_changed",next);
        await audit(c,id,"state_changed",next,next.approvedBy||next.updatedBy||"system");
        return {...clone(next),version};
      });
    },
    async list({state=null,limit=50}={}){
      await init();
      if(state!==null&&!Object.hasOwn(TRANSITIONS,state))throw new Error("Invalid reservation state");
      if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error("Invalid reservation limit");
      const r=await pool.query("SELECT aggregate_id,aggregate_version,payload FROM (SELECT DISTINCT ON (aggregate_id) aggregate_id,aggregate_version,payload FROM jarvis.events WHERE aggregate_type='reservation' ORDER BY aggregate_id,aggregate_version DESC) latest WHERE ($1::text IS NULL OR payload->>'state'=$1) ORDER BY payload->>'createdAt' DESC LIMIT $2",[state,limit]);
      return r.rows.map(x=>({...clone(x.payload),version:Number(x.aggregate_version)}));
    }
  };
}
module.exports={createPostgresSchedulingStore,TRANSITIONS,digest};
