"use strict";

// Durable scoped replay. NOTIFY is only a wake-up hint; callers always read rows
// from the outbox, so missed notifications do not lose events.
function createTaskEventOutbox({pool,maxBatch=500}={}) {
  if(!pool||typeof pool.query!=="function"||typeof pool.connect!=="function")throw new Error("PostgreSQL pool is required");
  if(!Number.isInteger(maxBatch)||maxBatch<1||maxBatch>5000)throw new Error("Invalid outbox batch size");
  async function replay({projectId,conversationId,afterCursor=0,limit=100}={}) {
    if(typeof projectId!=="string"||!projectId.trim()||projectId.length>128||
       typeof conversationId!=="string"||!conversationId.trim()||conversationId.length>128||
       !Number.isSafeInteger(afterCursor)||afterCursor<0||!Number.isInteger(limit)||limit<1||limit>maxBatch) {
      throw new Error("Invalid scoped outbox cursor request");
    }
    const bounds=await pool.query(
      "SELECT COALESCE(MAX(scope_cursor),0)::bigint AS max_cursor FROM jarvis.task_event_outbox WHERE project_id=$1 AND conversation_id=$2",
      [projectId,conversationId]
    );
    const maxCursor=Number(bounds.rows[0]?.max_cursor||0);
    if(afterCursor>maxCursor)throw new Error("Outbox cursor is ahead of the authorized scope");
    const result=await pool.query(
      "SELECT o.scope_cursor,o.source_event_id,o.task_id,o.event_type,o.created_at,e.aggregate_version,e.payload " +
      "FROM jarvis.task_event_outbox o JOIN jarvis.events e ON e.event_id=o.source_event_id " +
      "WHERE o.project_id=$1 AND o.conversation_id=$2 AND o.scope_cursor>$3 " +
      "ORDER BY o.scope_cursor ASC LIMIT $4",
      [projectId,conversationId,afterCursor,limit]
    );
    let expected=afterCursor+1;
    for(const row of result.rows){
      if(Number(row.scope_cursor)!==expected)throw new Error("Durable outbox cursor gap detected");
      expected++;
    }
    return result.rows.map(row=>({
      cursor:Number(row.scope_cursor),eventId:Number(row.source_event_id),taskId:row.task_id,
      version:Number(row.aggregate_version),eventType:row.event_type,createdAt:row.created_at,
      payload:row.payload
    }));
  }
  async function listen(onWake) {
    if(typeof onWake!=="function")throw new Error("Notification callback is required");
    const client=await pool.connect();
    let closed=false,released=false;
    const release=(destroy=false)=>{
      if(released)return;
      released=true;
      client.release(destroy?new Error("PostgreSQL notification listener connection lost"):undefined);
    };
    const handler=message=>{
      if(closed||message.channel!=="jarvis_task_events")return;
      const cursor=Number(message.payload);
      if(Number.isSafeInteger(cursor)&&cursor>0)Promise.resolve(onWake(cursor)).catch(()=>{});
    };
    // A checked-out pg Client does not emit its socket error through Pool's
    // idle-client error handler. Handle it here or a deliberate backend
    // termination becomes an uncaught EventEmitter error and kills the process.
    const onClientError=()=>{
      if(closed)return;
      closed=true;
      release(true);
      Promise.resolve(onWake(0)).catch(()=>{});
    };
    client.on("notification",handler);
    client.on("error",onClientError);
    try {
      await client.query("LISTEN jarvis_task_events");
    } catch(error) {
      closed=true;
      client.removeListener("notification",handler);
      client.removeListener("error",onClientError);
      release(true);
      throw error;
    }
    return async function close(){
      if(closed){client.removeListener("notification",handler);client.removeListener("error",onClientError);return;}
      closed=true;
      client.removeListener("notification",handler);
      client.removeListener("error",onClientError);
      try{await client.query("UNLISTEN jarvis_task_events");}finally{release();}
    };
  }
  return {replay,listen};
}
module.exports={createTaskEventOutbox};
