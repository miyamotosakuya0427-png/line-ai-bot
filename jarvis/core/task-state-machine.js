"use strict";

const TASK_STATES=Object.freeze(["pending","queued","claimed","running","waiting","waiting_approval","retry_wait","completed","failed","cancelled","outcome_unknown","quarantined"]);
const LEGACY_STATE_MAP=Object.freeze({proposed:"pending",ready:"queued",in_progress:"running",blocked:"waiting",review:"waiting_approval",verified:"completed"});
const LEGACY_STATES=Object.freeze(Object.keys(LEGACY_STATE_MAP));
const LEGACY_TRANSITIONS=Object.freeze({proposed:["ready","blocked","cancelled"],ready:["claimed","blocked","cancelled"],claimed:["in_progress","blocked","ready","cancelled"],in_progress:["blocked","review","ready","cancelled"],blocked:["ready","cancelled"],review:["in_progress","verified","blocked"],verified:["completed","review"],completed:[],cancelled:[]});
const ALL_TASK_STATES=new Set([...TASK_STATES,...LEGACY_STATES]);
const TRANSITIONS=Object.freeze({
  pending:["queued","waiting","cancelled"],
  queued:["claimed","waiting","cancelled"],
  claimed:["running","waiting","retry_wait","failed","cancelled","outcome_unknown","quarantined"],
  running:["waiting","waiting_approval","retry_wait","completed","failed","cancelled","outcome_unknown","quarantined"],
  waiting:["queued","retry_wait","cancelled","quarantined"],
  waiting_approval:["queued","running","cancelled","quarantined"],
  retry_wait:["queued","cancelled","quarantined"],
  completed:[],
  failed:["retry_wait","quarantined"],
  cancelled:[],
  outcome_unknown:["completed","failed","quarantined"],
  quarantined:["queued","cancelled"]
});
function canonicalTaskState(state){
  if(!ALL_TASK_STATES.has(state))throw new Error("Unknown task state");
  return LEGACY_STATE_MAP[state]||state;
}
function canTransitionTask(from,to){
  if(LEGACY_TRANSITIONS[from]?.includes(to))return true;
  const source=canonicalTaskState(from),target=canonicalTaskState(to);
  return TRANSITIONS[source].includes(target);
}
function assertTaskTransition(from,to){
  if(!canTransitionTask(from,to))throw new Error("Invalid task state transition: "+from+" -> "+to);
  return canonicalTaskState(to);
}
function isTerminalTaskState(state){return ["completed","cancelled"].includes(canonicalTaskState(state));}
module.exports={TASK_STATES,LEGACY_STATE_MAP,LEGACY_STATES,ALL_TASK_STATES,TRANSITIONS,canonicalTaskState,canTransitionTask,assertTaskTransition,isTerminalTaskState};
