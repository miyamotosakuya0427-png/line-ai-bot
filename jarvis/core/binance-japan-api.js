"use strict";

const crypto=require("node:crypto");
const {validateLimitOrder}=require("./binance-japan-spot");
const {RESOURCE_ID}=require("./binance-japan-executor");

function bearer(res,json,status,message){return json(res,status,{ok:false,error:message},{ "WWW-Authenticate":"Bearer" });}

async function handleBinanceApi({req,res,url,client=null,executor=null,approvalStore=null,token="",ownerToken="",json,readJson,isAuthorized,now=()=>new Date(),maxNotionalYen=5000}={}) {
  if(!url.pathname.startsWith("/v1/binance/"))return false;
  if(!json||!readJson||!isAuthorized)throw new Error("Binance API handler dependencies are incomplete");
  if(!isAuthorized(req,token))return bearer(res,json,token?401:503,token?"Unauthorized":"Authentication is not configured");
  if(!client)return json(res,503,{ok:false,error:"Binance Japan Spot adapter is not configured"});

  if(req.method==="GET"&&url.pathname==="/v1/binance/status"){
    return json(res,200,{ok:true,provider:"Binance Japan Spot API",enabled:true,apiKeyConfigured:Boolean(client.configured),accountReadEnabled:Boolean(client.configured),liveOrdersEnabled:Boolean(executor?.enabled),withdrawalsEnabled:false,marginEnabled:false,futuresEnabled:false,orderTypes:["LIMIT_GTC"],maxOrderNotionalJpy:maxNotionalYen});
  }
  if(req.method==="GET"&&url.pathname==="/v1/binance/market/ticker"){
    const symbol=(url.searchParams.get("symbol")||"").toUpperCase();
    if(!/^[A-Z0-9]{5,20}$/.test(symbol))return json(res,400,{ok:false,error:"A valid symbol is required"});
    const ticker=await client.tickerPrice(symbol);
    return json(res,200,{ok:true,source:"Binance Japan Spot API",ticker,verification:"exchange_response_not_independently_verified"});
  }
  if(req.method==="GET"&&url.pathname==="/v1/binance/market/klines"){
    const symbol=(url.searchParams.get("symbol")||"").toUpperCase(),interval=url.searchParams.get("interval")||"1h",limit=Number(url.searchParams.get("limit")||100);
    if(!/^[A-Z0-9]{5,20}$/.test(symbol)||!Number.isInteger(limit)||limit<1||limit>500)return json(res,400,{ok:false,error:"Invalid market data query"});
    const klines=await client.klines({symbol,interval,limit});
    return json(res,200,{ok:true,source:"Binance Japan Spot API",symbol,interval,klines,verification:"exchange_response_not_independently_verified"});
  }
  if(req.method==="GET"&&url.pathname==="/v1/binance/account"){
    if(!isAuthorized(req,ownerToken))return bearer(res,json,ownerToken?401:503,ownerToken?"Owner authentication required":"Owner authentication is not configured");
    if(!client.configured)return json(res,503,{ok:false,error:"Binance read-only API credentials are not configured"});
    const account=await client.account();
    const balances=(account.balances||[]).filter(x=>Number(x.free||0)>0||Number(x.locked||0)>0).map(x=>({asset:x.asset,free:x.free,locked:x.locked}));
    return json(res,200,{ok:true,account:{accountType:account.accountType,canTrade:account.canTrade,canWithdraw:account.canWithdraw,canDeposit:account.canDeposit,balances},safety:{withdrawalActionsExposed:false}});
  }
  if(req.method==="GET"&&url.pathname==="/v1/binance/permissions"){
    if(!isAuthorized(req,ownerToken))return bearer(res,json,ownerToken?401:503,ownerToken?"Owner authentication required":"Owner authentication is not configured");
    if(!client.configured)return json(res,503,{ok:false,error:"Binance read-only API credentials are not configured"});
    const permissions=await client.apiRestrictions();
    return json(res,200,{ok:true,permissions:{ipRestrict:permissions.ipRestrict,enableReading:permissions.enableReading,enableSpotAndMarginTrading:permissions.enableSpotAndMarginTrading,enableWithdrawals:permissions.enableWithdrawals,enableInternalTransfer:permissions.enableInternalTransfer,permitsUniversalTransfer:permissions.permitsUniversalTransfer,enableMargin:permissions.enableMargin,enableFutures:permissions.enableFutures,enableVanillaOptions:permissions.enableVanillaOptions},safety:{withdrawalsDisabled:permissions.enableWithdrawals===false,transfersDisabled:permissions.enableInternalTransfer===false&&permissions.permitsUniversalTransfer===false,derivativesDisabled:permissions.enableMargin===false&&permissions.enableFutures===false&&permissions.enableVanillaOptions===false}});
  }
  if(req.method==="GET"&&url.pathname==="/v1/binance/trades"){
    if(!isAuthorized(req,ownerToken))return bearer(res,json,ownerToken?401:503,ownerToken?"Owner authentication required":"Owner authentication is not configured");
    if(!client.configured)return json(res,503,{ok:false,error:"Binance read-only API credentials are not configured"});
    const symbol=(url.searchParams.get("symbol")||"").toUpperCase(),limit=Number(url.searchParams.get("limit")||100);
    if(!/^[A-Z0-9]{5,20}$/.test(symbol)||!Number.isInteger(limit)||limit<1||limit>1000)return json(res,400,{ok:false,error:"A valid symbol and trade limit are required"});
    const trades=await client.myTrades(symbol,{limit});
    return json(res,200,{ok:true,trades:trades.map(x=>({symbol:x.symbol,id:x.id,orderId:x.orderId,price:x.price,qty:x.qty,quoteQty:x.quoteQty,commission:x.commission,commissionAsset:x.commissionAsset,time:x.time,isBuyer:x.isBuyer,isMaker:x.isMaker}))});
  }
  if(req.method==="GET"&&url.pathname==="/v1/binance/open-orders"){
    if(!isAuthorized(req,ownerToken))return bearer(res,json,ownerToken?401:503,ownerToken?"Owner authentication required":"Owner authentication is not configured");
    if(!client.configured)return json(res,503,{ok:false,error:"Binance read-only API credentials are not configured"});
    const symbol=url.searchParams.get("symbol")||undefined;
    if(symbol&&!/^[A-Z0-9]{5,20}$/.test(symbol.toUpperCase()))return json(res,400,{ok:false,error:"Invalid symbol"});
    const orders=await client.openOrders(symbol?.toUpperCase());
    return json(res,200,{ok:true,orders:orders.map(x=>({symbol:x.symbol,orderId:x.orderId,clientOrderId:x.clientOrderId,side:x.side,type:x.type,status:x.status,price:x.price,origQty:x.origQty,executedQty:x.executedQty,updateTime:x.updateTime}))});
  }
  if(req.method==="POST"&&url.pathname==="/v1/binance/orders/prepare"){
    if(!client.configured)return json(res,503,{ok:false,error:"Binance API credentials are required to prepare a live order"});
    if(!approvalStore)return json(res,503,{ok:false,error:"Persistent approval storage is not configured"});
    if(!req.headers["content-type"]?.toLowerCase().startsWith("application/json"))return json(res,415,{ok:false,error:"Content-Type must be application/json"});
    const d=await readJson(req);
    const symbol=String(d.symbol||"").toUpperCase();
    const info=await client.exchangeInfo(symbol);
    const order=validateLimitOrder({symbol,side:d.side,price:d.price,quantity:d.quantity},info,{maxNotional:String(maxNotionalYen)});
    if(typeof d.idempotencyKey!=="string"||d.idempotencyKey.trim().length<8||d.idempotencyKey.length>128)return json(res,400,{ok:false,error:"A unique idempotencyKey of 8-128 characters is required"});
    const clientOrderId="OJ"+crypto.createHash("sha256").update(d.idempotencyKey.trim()).digest("hex").slice(0,32);
    const operationPayload={...order,clientOrderId};
    const expiresAt=new Date(now().getTime()+15*60*1000).toISOString();
    const result=await approvalStore.create({
      departmentId:"trader",actionClass:"financial",
      summary:"Binance Japan Spot "+order.side+" "+order.symbol+" limit order",
      details:"JPY notional="+(Number(order.price)*Number(order.quantity))+"; GTC limit; no leverage; approval required.",
      idempotencyKey:"binance-japan:"+clientOrderId,resourceId:RESOURCE_ID,operationPayload,expiresAt
    });
    return json(res,result.created?201:200,{ok:true,created:result.created,approval:result.approval,executionEnabled:false,message:"注文案を保存しました。管理者の明示承認とリスク検査が終わるまで発注しません。"});
  }
  const executeMatch=/^\/v1\/binance\/orders\/([0-9a-f-]{36})\/(execute|reconcile)$/.exec(url.pathname);
  if(executeMatch&&req.method==="POST"){
    if(!isAuthorized(req,ownerToken))return bearer(res,json,ownerToken?401:503,ownerToken?"Owner authentication required":"Owner authentication is not configured");
    if(!executor)return json(res,503,{ok:false,error:"Binance order executor is not configured"});
    if(executeMatch[2]==="execute"){
      const result=await executor.execute(executeMatch[1]);
      return json(res,result.ok?200:result.status==="disabled"?423:result.status==="not_found"?404:409,{ok:result.ok,...result});
    }
    const result=await executor.reconcile(executeMatch[1]);
    return json(res,result.ok?200:result.status==="not_found"?404:409,{ok:result.ok,...result});
  }
  return json(res,404,{ok:false,error:"Not Found"});
}
module.exports={handleBinanceApi};
