"use strict";

const RESOURCE_ID="binance-japan-spot";
const ACTOR="binance-japan-spot-executor";

function createBinanceJapanOrderExecutor({client,approvalStore,enabled=false,ownerAuthReady=false,maxNotionalYen=5000,authorizeRisk=async()=>false}={}) {
  if(!client||typeof client.placeLimitOrder!=="function"||!approvalStore||typeof approvalStore.claimExecution!=="function"||typeof approvalStore.finishExecution!=="function")throw new Error("Binance executor dependencies are incomplete");
  if(!Number.isSafeInteger(maxNotionalYen)||maxNotionalYen<1||maxNotionalYen>1000000)throw new Error("Invalid Binance order limit");
  async function execute(approvalId) {
    if(!enabled||!ownerAuthReady)return {ok:false,status:"disabled",message:"Live Binance order execution is disabled"};
    const approval=await approvalStore.get(approvalId);
    if(!approval)return {ok:false,status:"not_found"};
    const payload=approval.operationPayload;
    if(approval.resourceId!==RESOURCE_ID||approval.actionClass!=="financial"||!payload||payload.type!=="LIMIT"||payload.timeInForce!=="GTC")throw new Error("Approval is not a valid Binance Japan Spot limit order");
    const notional=Number(payload.price)*Number(payload.quantity);
    if(!Number.isFinite(notional)||notional<=0||notional>maxNotionalYen)throw new Error("Binance order exceeds the configured JPY notional limit");
    const risk=await authorizeRisk({approval,payload,notionalYen:notional});
    if(!risk||risk.allowed!==true)throw new Error("Live order risk gate rejected the order");
    const claim=await approvalStore.claimExecution(approvalId,{resourceId:RESOURCE_ID,operationPayload:payload,actor:ACTOR});
    if(!claim)return {ok:false,status:"not_found"};
    try {
      const order=await client.placeLimitOrder({...payload,newClientOrderId:payload.clientOrderId});
      await approvalStore.finishExecution(approvalId,{claimId:claim.executionClaim.id,actor:ACTOR,outcome:"succeeded",reason:"Binance order accepted; orderId="+String(order.orderId||"unknown")});
      return {ok:true,status:"submitted",order:{symbol:order.symbol,orderId:order.orderId,clientOrderId:order.clientOrderId,status:order.status,price:order.price,origQty:order.origQty,executedQty:order.executedQty}};
    } catch(error) {
      if(error.definitive===true) {
        await approvalStore.finishExecution(approvalId,{claimId:claim.executionClaim.id,actor:ACTOR,outcome:"failed",reason:"Binance definitively rejected the order; code="+String(error.code??"unknown")});
        return {ok:false,status:"rejected",code:error.code??null};
      }
      return {ok:false,status:"outcome_unknown",message:"Order dispatch outcome is unknown. The approval remains claimed; do not retry. Reconcile by client order ID."};
    }
  }
  async function reconcile(approvalId) {
    const approval=await approvalStore.get(approvalId);
    if(!approval||approval.resourceId!==RESOURCE_ID||!approval.operationPayload)return {ok:false,status:"not_found"};
    if(approval.executionStatus!=="claimed"||!approval.executionClaim)return {ok:false,status:"not_reconcilable"};
    try {
      const order=await client.orderByClientId(approval.operationPayload.symbol,approval.operationPayload.clientOrderId);
      await approvalStore.finishExecution(approvalId,{claimId:approval.executionClaim.id,actor:ACTOR,outcome:"succeeded",reason:"Reconciled existing Binance order; orderId="+String(order.orderId||"unknown")});
      return {ok:true,status:"reconciled",order:{symbol:order.symbol,orderId:order.orderId,clientOrderId:order.clientOrderId,status:order.status}};
    } catch(error) {
      return {ok:false,status:"outcome_unknown",message:"No safe proof of order absence was obtained. Do not submit a replacement order."};
    }
  }
  return Object.freeze({execute,reconcile,enabled:Boolean(enabled&&ownerAuthReady)});
}
module.exports={RESOURCE_ID,ACTOR,createBinanceJapanOrderExecutor};
