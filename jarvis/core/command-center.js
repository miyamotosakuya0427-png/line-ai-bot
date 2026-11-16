"use strict";

const {DEPARTMENTS,validateAgentTask}=require("./department-agents");

const ACTIONS=new Set(["read","analyze","draft","notify","internal_task","external_submit","financial","contract","publish","delete","permission_change"]);
const SAFE_ACTIONS=new Set(["read","analyze","draft","notify","internal_task"]);
const JOB_STATES=["queued","running","succeeded","failed","cancelled"];

function createCommandCenter({jobStore=null,approvalStore=null,worker=null,departmentHandlers=null,departmentContextLoader=null,clock=()=>new Date().toISOString()}={}){
  async function snapshot(){
    const jobs=jobStore?await jobStore.list({limit:200}):[];
    const approvals=approvalStore?await approvalStore.list({status:"pending",limit:200}):[];
    const departments=DEPARTMENTS.map(department=>{
      const matching=jobs.filter(job=>job.type==="department."+department.id);
      const latest=matching.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]||null;
      return {
        id:department.id,name:department.name,agent:department.agent,mission:department.mission,
        runtimeConfigured:Boolean(jobStore&&worker&&departmentHandlers&&typeof departmentHandlers["department."+department.id]==="function"),
        dataAdapterConfigured:Boolean(departmentContextLoader&&departmentContextLoader.configured&&typeof departmentContextLoader.supports==="function"&&departmentContextLoader.supports(department.id)),capabilities:department.canAutonomously,
        requiresOwnerApproval:department.requiresOwnerApproval,
        recentJobs:matching.length,latestJob:latest?{id:latest.id,status:latest.status,createdAt:latest.createdAt,updatedAt:latest.updatedAt}:null
      };
    });
    const counts=Object.fromEntries(JOB_STATES.map(state=>[state,jobs.filter(job=>job.status===state).length]));
    return {
      system:"ONE JARVIS COMMAND CENTER",generatedAt:clock(),
      operatingMode:"controlled_autonomy",
      execution:{queueConfigured:Boolean(jobStore),workerConfigured:Boolean(worker),companyDataAdapterConfigured:Boolean(departmentContextLoader&&departmentContextLoader.configured),externalActionsEnabled:false,liveTradingEnabled:false,publicPublishingEnabled:false},
      jobSample:{limit:200,returned:jobs.length,counts,mayBePartial:jobs.length===200},
      pendingApprovals:approvals.length,
      departments
    };
  }

  async function dispatch({request,departmentIds,actionClass="analyze",idempotencyKey=""}={}){
    if(typeof request!=="string"||!request.trim()||request.length>4000)throw new Error("Task request must be 1-4000 characters");
    if(!Array.isArray(departmentIds)||departmentIds.length<1||departmentIds.length>DEPARTMENTS.length)throw new Error("Select 1 to "+DEPARTMENTS.length+" departments");
    if(new Set(departmentIds).size!==departmentIds.length)throw new Error("Duplicate department IDs are not allowed");
    if(!ACTIONS.has(actionClass))throw new Error("Unsupported action class");
    if(SAFE_ACTIONS.has(actionClass)){
      if(!jobStore||!worker){const error=new Error("Persistent job queue and worker are not configured");error.statusCode=503;throw error;}
      const missing=departmentIds.filter(id=>validateAgentTask({departmentId:id,actionClass}).allowed&&(!departmentHandlers||typeof departmentHandlers["department."+id]!=="function"));
      if(missing.length){const error=new Error("Department handlers are not configured: "+missing.join(", "));error.statusCode=503;throw error;}
    }
    if(typeof idempotencyKey!=="string"||idempotencyKey.length>100)throw new Error("Invalid idempotency key");
    const results=[];
    for(const departmentId of departmentIds){
      const policy=validateAgentTask({departmentId,actionClass});
      if(!policy.allowed&&!policy.approvalRequired){results.push({departmentId,status:"blocked",reason:policy.reason});continue;}
      if(policy.approvalRequired){
        if(!approvalStore){results.push({departmentId,status:"blocked",reason:"OWNER_APPROVAL_STORE_UNAVAILABLE"});continue;}
        const result=await approvalStore.create({
          departmentId,actionClass,summary:"JARVIS司令塔："+request.trim().slice(0,220),
          details:JSON.stringify({request:request.trim(),departmentId,actionClass,createdBy:"command-center",executionEnabled:false}),
          idempotencyKey:idempotencyKey?("cc-approval-"+idempotencyKey+"-"+departmentId):""
        });
        results.push({departmentId,status:"awaiting_owner_approval",created:result.created,approval:result.approval});
        continue;
      }
      if(!SAFE_ACTIONS.has(actionClass)){results.push({departmentId,status:"blocked",reason:"ACTION_NOT_AUTONOMOUS"});continue;}
      const result=await jobStore.create({
        type:"department."+departmentId,
        payload:{request:request.trim(),departmentId,actionClass,source:"command-center",requestedAt:clock()},
        idempotencyKey:idempotencyKey?("cc-task-"+idempotencyKey+"-"+departmentId):""
      });
      results.push({departmentId,status:result.job.status,created:result.created,job:result.job});
    }
    return {ok:true,executionEnabled:Boolean(worker),externalActionsEnabled:false,results};
  }
  return {snapshot,dispatch};
}
module.exports={ACTIONS,SAFE_ACTIONS,JOB_STATES,createCommandCenter};
