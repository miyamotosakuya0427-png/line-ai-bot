"use strict";

const crypto = require("node:crypto");

const ACTION_TYPES = Object.freeze([
  "paid_generation",
  "purchase_or_subscription",
  "external_upload",
  "publish",
  "schedule_publication",
  "contract",
  "external_submission",
  "data_deletion",
  "permission_change"
]);

function sha256(value) {
  return crypto.createHash("sha256").update(value,"utf8").digest("hex");
}

function validateRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid approval request");
  const { actionType, description, target } = input;
  if (!ACTION_TYPES.includes(actionType)) throw new Error("Unsupported approval action type");
  if (typeof description !== "string" || !description.trim() || description.length > 1000) throw new Error("Approval description is required and must be at most 1000 characters");
  if (typeof target !== "string" || !target.trim() || target.length > 1000) throw new Error("Approval target is required and must be at most 1000 characters");
  return { actionType, description: description.trim(), target: target.trim(), targetSha256: sha256(target.trim()) };
}

async function createApprovalRequest(store, input) {
  if (!store || typeof store.create !== "function") throw new Error("Persistent approval storage is unavailable");
  const details = validateRequest(input);
  return store.create({
    type: "content.approval_request",
    payload: { ...details, state: "pending", sideEffectsEnabled: false },
    idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey : ""
  });
}

async function listApprovals(store) {
  if (!store || typeof store.list !== "function") throw new Error("Persistent approval storage is unavailable");
  const jobs = await store.list({ limit: 200 });
  const requests = jobs.filter(job => job.type === "content.approval_request");
  const decisions = jobs.filter(job => job.type === "content.approval_decision");
  return requests.map(job => {
    const decision = decisions.find(item => item.payload.approvalId === job.id) || null;
    return { id: job.id, ...job.payload, status: decision ? "decided" : "pending", decision: decision ? decision.payload : null, createdAt: job.createdAt };
  }).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}

async function decideApproval(store, approvalId, input) {
  if (!store || typeof store.get !== "function" || typeof store.create !== "function") throw new Error("Persistent approval storage is unavailable");
  if (typeof approvalId !== "string" || !/^[0-9a-f-]{36}$/i.test(approvalId)) throw new Error("Invalid approval ID");
  if (!input || typeof input.approved !== "boolean") throw new Error("Decision must be approved=true or false");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length > 1000) throw new Error("Decision reason must be at most 1000 characters");
  const request = await store.get(approvalId);
  if (!request || request.type !== "content.approval_request") throw new Error("Approval request not found");
  const jobs = await store.list({ limit: 200 });
  if (jobs.some(job => job.type === "content.approval_decision" && job.payload.approvalId === approvalId)) throw new Error("Approval request has already been decided");
  return store.create({
    type: "content.approval_decision",
    payload: {
      approvalId,
      approved: input.approved,
      reason,
      targetSha256: request.payload.targetSha256,
      sideEffectsEnabled: false
    },
    idempotencyKey: "content-approval-decision-" + approvalId
  });
}

module.exports = { ACTION_TYPES, sha256, validateRequest, createApprovalRequest, listApprovals, decideApproval };
