"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {TASK_STATES,LEGACY_STATE_MAP,canonicalTaskState,canTransitionTask,assertTaskTransition,isTerminalTaskState}=require("./task-state-machine");
test("formal Task State Machine exposes all required states",()=>{
  assert.deepEqual(TASK_STATES,["pending","queued","claimed","running","waiting","waiting_approval","retry_wait","completed","failed","cancelled","outcome_unknown","quarantined"]);
});
test("legacy state mapping is explicit and preserves old event values",()=>{
  assert.equal(canonicalTaskState("ready"),"queued");
  assert.equal(canonicalTaskState("in_progress"),"running");
  assert.equal(canonicalTaskState("blocked"),"waiting");
  assert.equal(canonicalTaskState("review"),"waiting_approval");
  assert.equal(canonicalTaskState("verified"),"completed");
  assert.equal(LEGACY_STATE_MAP.ready,"queued");
});
test("state machine rejects invalid, terminal, and backward transitions",()=>{
  assert.equal(canTransitionTask("queued","claimed"),true);
  assert.equal(canTransitionTask("running","retry_wait"),true);
  assert.equal(canTransitionTask("running","completed"),true);
  assert.equal(canTransitionTask("claimed","ready"),true,"legacy claim release remains compatible");
  assert.equal(canTransitionTask("in_progress","ready"),true,"legacy retry release remains compatible");
  assert.equal(canTransitionTask("verified","review"),true,"legacy verification re-review remains compatible");
  assert.equal(canTransitionTask("completed","queued"),false);
  assert.equal(canTransitionTask("outcome_unknown","queued"),false);
  assert.throws(()=>assertTaskTransition("pending","completed"),/Invalid task state transition/);
  assert.equal(isTerminalTaskState("completed"),true);
  assert.equal(isTerminalTaskState("failed"),false);
});
test("outcome_unknown requires explicit reconciliation before terminal resolution",()=>{
  assert.equal(canTransitionTask("outcome_unknown","completed"),true);
  assert.equal(canTransitionTask("outcome_unknown","failed"),true);
  assert.equal(canTransitionTask("outcome_unknown","retry_wait"),false);
  assert.equal(canTransitionTask("quarantined","queued"),true);
});
