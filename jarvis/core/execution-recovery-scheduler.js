"use strict";
function createExecutionRecoveryScheduler({executionKernel,intervalMs=15000,batchSize=50,onError=()=>{}}={}){
 if(!executionKernel||typeof executionKernel.recoverExpiredWorkers!=="function")throw new Error("PostgreSQL execution recovery kernel is required");
 if(!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>3600000||!Number.isInteger(batchSize)||batchSize<1||batchSize>500||typeof onError!=="function")throw new Error("Invalid recovery scheduler configuration");
 let timer=null,running=false,stopped=true;
 async function runOnce(){
  if(running)return{skipped:true,reason:"recovery scan already running"};
  running=true;
  try{return{skipped:false,results:await executionKernel.recoverExpiredWorkers({limit:batchSize})};}
  catch(error){try{onError(error);}catch{}throw error;}
  finally{running=false;}
 }
 function start(){
  if(timer)return{started:false,reason:"already started"};
  stopped=false;
  timer=setInterval(()=>{if(!stopped)runOnce().catch(()=>{});},intervalMs);
  timer.unref?.();
  return{started:true,intervalMs,batchSize};
 }
 function stop(){
  if(timer)clearInterval(timer);
  timer=null;stopped=true;
  return{stopped:true};
 }
 return{runOnce,start,stop,get running(){return running;},get started(){return Boolean(timer);}};
}
module.exports={createExecutionRecoveryScheduler};
