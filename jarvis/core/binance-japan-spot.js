"use strict";

const crypto=require("node:crypto");

const ALLOWED_BASE_URLS=new Set([
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api-gcp.binance.com"
]);
const INTERVALS=new Set(["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w","1M"]);
const SYMBOL=/^[A-Z0-9]{5,20}$/;
const DECIMAL=/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

class BinanceApiError extends Error {
  constructor(message,{statusCode=502,code=null,definitive=false}={}) {
    super(message);this.name="BinanceApiError";this.statusCode=statusCode;this.code=code;this.definitive=definitive;
  }
}
function decimalParts(value,name) {
  const s=String(value);
  if(!DECIMAL.test(s))throw new Error("Invalid "+name);
  const [whole,fraction=""]=s.split(".");
  return {n:BigInt(whole+fraction),scale:fraction.length};
}
function align(a,b){const scale=Math.max(a.scale,b.scale);return [a.n*10n**BigInt(scale-a.scale),b.n*10n**BigInt(scale-b.scale)];}
function decimalMultiple(value,step){const [v,s]=align(decimalParts(value,"value"),decimalParts(step,"step"));return s>0n&&v%s===0n;}
function decimalCompare(a,b){const [x,y]=align(decimalParts(a,"value"),decimalParts(b,"bound"));return x<y?-1:x>y?1:0;}
function decimalProductAtLeast(a,b,min){const x=decimalParts(a,"price"),y=decimalParts(b,"quantity"),z=decimalParts(min,"minimum notional");const n=x.n*y.n;const scale=x.scale+y.scale;const [left,right]=align({n,scale},z);return left>=right;}
function validateLimitOrder(order,exchangeInfo,{maxNotional="5000"}={}) {
  if(!order||typeof order!=="object"||Array.isArray(order))throw new Error("Invalid order");
  const symbol=String(order.symbol||"").toUpperCase(),side=String(order.side||"").toUpperCase();
  if(!SYMBOL.test(symbol)||!symbol.endsWith("JPY"))throw new Error("Only configured JPY spot pairs are allowed");
  if(!["BUY","SELL"].includes(side))throw new Error("Invalid order side");
  const quantity=String(order.quantity||""),price=String(order.price||"");
  decimalParts(quantity,"quantity");decimalParts(price,"price");
  if(decimalCompare(quantity,"0")<=0||decimalCompare(price,"0")<=0)throw new Error("Price and quantity must be positive");
  if(!exchangeInfo||!Array.isArray(exchangeInfo.symbols))throw new Error("Exchange symbol rules are unavailable");
  const market=exchangeInfo.symbols.find(x=>x.symbol===symbol&&x.status==="TRADING"&&x.isSpotTradingAllowed!==false);
  if(!market)throw new Error("Symbol is not available for spot trading");
  const filters=Object.fromEntries((market.filters||[]).map(x=>[x.filterType,x]));
  const priceFilter=filters.PRICE_FILTER,lot=filters.LOT_SIZE,notional=filters.NOTIONAL||filters.MIN_NOTIONAL;
  if(!priceFilter||!lot)throw new Error("Required Binance symbol filters are unavailable");
  if(decimalCompare(price,priceFilter.minPrice)<0||decimalCompare(price,priceFilter.maxPrice)>0||!decimalMultiple(price,priceFilter.tickSize))throw new Error("Price violates Binance PRICE_FILTER");
  if(decimalCompare(quantity,lot.minQty)<0||decimalCompare(quantity,lot.maxQty)>0||!decimalMultiple(quantity,lot.stepSize))throw new Error("Quantity violates Binance LOT_SIZE");
  const maximum=String(maxNotional);
  const product=Number(price)*Number(quantity);
  if(!Number.isFinite(product)||product>Number(maximum))throw new Error("Order exceeds the configured JPY notional limit");
  if(notional&&notional.minNotional&& !decimalProductAtLeast(price,quantity,notional.minNotional))throw new Error("Order is below Binance minimum notional");
  return {symbol,side,type:"LIMIT",timeInForce:"GTC",quantity,price};
}

function createBinanceJapanSpotClient({apiKey="",secret="",baseUrl="https://api.binance.com",fetchImpl=fetch,clock=()=>Date.now(),recvWindow=5000,timeoutMs=10000}={}) {
  if(!ALLOWED_BASE_URLS.has(baseUrl))throw new Error("Binance base URL is not allowlisted");
  if(typeof fetchImpl!=="function"||typeof clock!=="function")throw new Error("Invalid Binance client dependencies");
  if(!Number.isInteger(recvWindow)||recvWindow<1000||recvWindow>60000)throw new Error("Invalid Binance receive window");
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)throw new Error("Invalid Binance timeout");
  if(apiKey&& (typeof apiKey!=="string"||apiKey.length>256))throw new Error("Invalid Binance API key");
  if(secret&& (typeof secret!=="string"||secret.length>256))throw new Error("Invalid Binance API secret");

  async function request(method,path,params={},signed=false) {
    const values={...params};
    const headers={"Accept":"application/json"};
    if(signed) {
      if(!apiKey||!secret)throw new BinanceApiError("Binance account credentials are not configured",{statusCode:503});
      values.timestamp=String(clock());values.recvWindow=String(recvWindow);
    }
    const query=new URLSearchParams();
    for(const [key,value] of Object.entries(values))if(value!==undefined&&value!==null)query.set(key,String(value));
    if(signed)query.set("signature",crypto.createHmac("sha256",secret).update(query.toString()).digest("hex"));
    if(signed)headers["X-MBX-APIKEY"]=apiKey;
    const url=baseUrl+path+(query.size?"?"+query.toString():"");
    let response;
    try{response=await fetchImpl(url,{method,headers,signal:AbortSignal.timeout(timeoutMs)});}
    catch(error){throw new BinanceApiError("Binance request outcome is unknown",{statusCode:502,definitive:false});}
    let data;
    try{data=await response.json();}catch{throw new BinanceApiError("Binance returned an unreadable response",{statusCode:502,definitive:false});}
    if(!response.ok) {
      const code=Number.isInteger(data?.code)?data.code:null;
      const definitive=response.status>=400&&response.status<500&&code!==null&&![-1006,-1007,-1008].includes(code);
      throw new BinanceApiError("Binance API request failed",{statusCode:response.status>=500?502:response.status,code,definitive});
    }
    return data;
  }

  return Object.freeze({
    configured:Boolean(apiKey&&secret),
    async exchangeInfo(symbol){return request("GET","/api/v3/exchangeInfo",symbol?{symbol:String(symbol).toUpperCase()}:{});},
    async tickerPrice(symbol){if(symbol&&!SYMBOL.test(String(symbol).toUpperCase()))throw new Error("Invalid symbol");return request("GET","/api/v3/ticker/price",symbol?{symbol:String(symbol).toUpperCase()}:{});},
    async klines({symbol,interval="1h",limit=100}={}) {
      const normalized=String(symbol||"").toUpperCase();
      if(!SYMBOL.test(normalized)||!INTERVALS.has(interval)||!Number.isInteger(limit)||limit<1||limit>500)throw new Error("Invalid kline request");
      return request("GET","/api/v3/klines",{symbol:normalized,interval,limit});
    },
    async account(){return request("GET","/api/v3/account",{omitZeroBalances:"true"},true);},
    async openOrders(symbol){if(symbol&&!SYMBOL.test(String(symbol).toUpperCase()))throw new Error("Invalid symbol");return request("GET","/api/v3/openOrders",symbol?{symbol:String(symbol).toUpperCase()}: {},true);},
    async orderByClientId(symbol,clientOrderId){
      if(!SYMBOL.test(String(symbol||"").toUpperCase())||typeof clientOrderId!=="string"||!/^OJ[A-Za-z0-9]{8,34}$/.test(clientOrderId))throw new Error("Invalid order reconciliation request");
      return request("GET","/api/v3/order",{symbol:String(symbol).toUpperCase(),origClientOrderId:clientOrderId},true);
    },
    async placeLimitOrder(order){
      if(!order||order.type!=="LIMIT"||order.timeInForce!=="GTC")throw new Error("Only GTC limit orders are supported");
      return request("POST","/api/v3/order",{symbol:order.symbol,side:order.side,type:"LIMIT",timeInForce:"GTC",quantity:order.quantity,price:order.price,newClientOrderId:order.newClientOrderId},true);
    }
  });
}

module.exports={ALLOWED_BASE_URLS,INTERVALS,BinanceApiError,createBinanceJapanSpotClient,validateLimitOrder,decimalMultiple};
