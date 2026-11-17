"use strict";
const {createPostgresSchedulingStore}=require("./postgres-scheduling-store");
const {createSchedulingReservationAgent}=require("./scheduling-reservation-agent");

function createSchedulingReservationRuntime({pool,calendar,booking,taskRegistry,authorizeApproval,clock=()=>new Date().toISOString()}={}){
  const store=createPostgresSchedulingStore({pool,clock});
  const agent=createSchedulingReservationAgent({calendar,booking,store,taskRegistry,authorizeApproval,clock});
  let initialized=null;
  return {
    store,
    agent,
    async init(){
      if(!initialized)initialized=store.init().catch(error=>{initialized=null;throw error;});
      await initialized;
      return {ok:true,storage:"postgresql",migration:"0006_scheduling_reservation_store"};
    }
  };
}
module.exports={createSchedulingReservationRuntime};
