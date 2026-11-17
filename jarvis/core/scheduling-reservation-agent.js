"use strict";
const crypto=require("node:crypto");

const RESERVATION_STATES=new Set(["proposed","approval_pending","confirmed","outcome_unknown","cancel_pending","cancelled","failed"]);
const MAX_JSON=12000;
function stable(value){
  if(Array.isArray(value))return "["+value.map(stable).join(",")+"]";
  if(value&&typeof value==="object")return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}";
  return JSON.stringify(value);
}
function digest(value){return crypto.createHash("sha256").update(stable(value)).digest("hex");}
function requiredString(value,max=200){if(typeof value!=="string"||!value.trim()||value.length>max)throw new Error("Invalid scheduling input");return value.trim();}
function validDate(value){const n=Date.parse(value);if(!Number.isFinite(n)||!/^\d{4}-\d\d-\d\dT/.test(value))throw new Error("A timezone-qualified ISO date-time is required");return n;}
function createSchedulingReservationAgent({calendar,booking,store,taskRegistry,authorizeApproval,clock=()=>new Date().toISOString()}={}){
  if(!calendar||typeof calendar.listEvents!=="function")throw new Error("A calendar adapter is required");
  if(!booking||typeof booking.searchAvailability!=="function")throw new Error("A booking availability adapter is required");
  if(!store||!["create","get","update"].every(k=>typeof store[k]==="function"))throw new Error("A durable scheduling store is required");
  if(typeof authorizeApproval!=="function")throw new Error("An approval verifier is required");
  if(!taskRegistry||typeof taskRegistry.createTask!=="function")throw new Error("Task Registry is required");
  async function propose(input={}){
    const title=requiredString(input.title,200),provider=requiredString(input.provider,120);
    const start=requiredString(input.start,80),end=requiredString(input.end,80);
    const startMs=validDate(start),endMs=validDate(end);
    if(endMs<=startMs)throw new Error("End must be after start");
    const partySize=input.partySize===undefined?null:input.partySize;
    if(partySize!==null&&(!Number.isInteger(partySize)||partySize<1||partySize>100))throw new Error("Invalid party size");
    const events=await calendar.listEvents({start,end});
    const conflicts=events.filter(e=>Date.parse(e.start)<endMs&&Date.parse(e.end)>startMs);
    const availability=await booking.searchAvailability({provider,start,end,partySize,service:input.service||null});
    const proposal={title,provider,start,end,partySize,service:input.service||null,availability,calendarConflictCount:conflicts.length};
    const operationHash=digest(proposal),id=crypto.randomUUID(),now=clock();
    const record={id,type:"reservation",state:"proposed",proposal,operationHash,idempotencyKey:"jarvis-reservation-"+operationHash,createdAt:now,updatedAt:now,requiresApproval:true,calendarConflicts:conflicts.map(e=>({id:e.id||null,start:e.start,end:e.end,title:e.title||""}))};
    await store.create(record);
    const task=await taskRegistry.createTask({title:"予約候補の確認："+title,scope:"予約提案を確認し、候補日時・競合・料金・取消条件を確認する。外部予約は承認まで実行禁止。",dedupeKey:"schedule-proposal:"+operationHash,projectId:input.projectId||"one-jarvis",ownerAgent:input.ownerAgent||"scheduling",ownerConversation:input.ownerConversation||"scheduling",priority:"P2",status:"proposed"});
    return {record,task,canConfirm:conflicts.length===0&&Array.isArray(availability)&&availability.length>0};
  }
  async function confirmReservation({id,approval}={}){
    const record=await store.get(requiredString(id,80));
    if(!record||record.type!=="reservation")throw new Error("Reservation proposal not found");
    if(record.state==="confirmed")return {record,duplicate:true};
    if(record.state==="outcome_unknown")return {record,requiresReconciliation:true};
    if(record.state!=="proposed"&&record.state!=="approval_pending")throw new Error("Reservation is not confirmable");
    const verified=await authorizeApproval(approval,{action:"reservation.create",resourceId:record.id,operationHash:record.operationHash});
    if(!verified||verified.approved!==true||verified.operationHash!==record.operationHash||!verified.approvalId)throw new Error("A matching explicit approval is required");
    if(booking.supportsIdempotency!==true||typeof booking.createReservation!=="function")throw new Error("Booking adapter lacks a verified idempotent create contract; fail closed");
    const before=await calendar.listEvents({start:record.proposal.start,end:record.proposal.end});
    if(before.some(e=>Date.parse(e.start)<Date.parse(record.proposal.end)&&Date.parse(e.end)>Date.parse(record.proposal.start)))throw new Error("Calendar conflict appeared after proposal; re-propose");
    await store.update(id,{state:"approval_pending",approvalId:verified.approvalId,updatedAt:clock()});
    try{
      const result=await booking.createReservation({...record.proposal,idempotencyKey:record.idempotencyKey,approvalId:verified.approvalId});
      if(!result||result.confirmed!==true||!result.reservationId)throw Object.assign(new Error("Booking outcome not confirmed"),{outcomeUnknown:true});
      const confirmed={...record,state:"confirmed",reservationId:result.reservationId,providerConfirmation:result.confirmation||null,confirmedAt:clock(),updatedAt:clock(),approvalId:verified.approvalId};
      await store.update(id,confirmed);
      return {record:confirmed,duplicate:false};
    }catch(error){
      const uncertain=error?.outcomeUnknown===true||error?.requestStarted===true;
      const next={...record,state:uncertain?"outcome_unknown":"failed",approvalId:verified.approvalId,lastError:"Booking provider did not return a definitive confirmation",updatedAt:clock()};
      await store.update(id,next);
      return {record:next,requiresReconciliation:uncertain};
    }
  }
  async function reconcileReservation({id}={}){
    const record=await store.get(requiredString(id,80));
    if(!record||record.type!=="reservation")throw new Error("Reservation not found");
    if(record.state!=="outcome_unknown")return {record,changed:false};
    if(typeof booking.getReservationByIdempotencyKey!=="function")return {record,changed:false,blocked:"Provider does not support outcome lookup; manual reconciliation required"};
    const result=await booking.getReservationByIdempotencyKey(record.idempotencyKey);
    if(!result||result.status==="not_found")return {record,changed:false,blocked:"Absence is not proof that a delayed booking request cannot still complete; manual reconciliation required"};
    if(result.confirmed===true&&result.reservationId){
      const next={...record,state:"confirmed",reservationId:result.reservationId,providerConfirmation:result.confirmation||null,confirmedAt:clock(),updatedAt:clock()};
      await store.update(id,next);return {record:next,changed:true};
    }
    return {record,changed:false,blocked:"Provider outcome remains ambiguous"};
  }
  return {propose,confirmReservation,reconcileReservation};
}
module.exports={createSchedulingReservationAgent,RESERVATION_STATES,digest};
