"use strict";

const crypto=require("node:crypto");
const ALLOWED_ALGORITHMS=new Set(["RS256","ES256"]);

function decodePart(value,label){
  if(typeof value!=="string"||!value||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error("Invalid OIDC JWT "+label);
  try{return Buffer.from(value,"base64url");}catch{throw new Error("Invalid OIDC JWT "+label);}
}
function parseJsonPart(value,label){
  try{return JSON.parse(decodePart(value,label).toString("utf8"));}catch{throw new Error("Invalid OIDC JWT "+label);}
}
function safeEqual(left,right){
  if(typeof left!=="string"||typeof right!=="string")return false;
  const a=Buffer.from(left),b=Buffer.from(right);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
function createPkceLoginRequest({authorizationEndpoint,clientId,redirectUri,scopes=["openid","profile"],randomBytes=crypto.randomBytes}={}){
  const endpoint=new URL(authorizationEndpoint);
  const callback=new URL(redirectUri);
  if(endpoint.protocol!=="https:"||callback.protocol!=="https:"||endpoint.username||endpoint.password||callback.username||callback.password||endpoint.hash||callback.hash||typeof clientId!=="string"||!clientId.trim()||!Array.isArray(scopes)||!scopes.length||!scopes.includes("openid")||scopes.some(scope=>typeof scope!=="string"||! /^[A-Za-z0-9._:-]{1,64}$/.test(scope))||new Set(scopes).size!==scopes.length)throw new Error("Invalid OIDC authorization configuration");
  const state=randomBytes(32).toString("base64url");
  const nonce=randomBytes(32).toString("base64url");
  const codeVerifier=randomBytes(48).toString("base64url");
  const codeChallenge=crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  endpoint.searchParams.set("response_type","code");
  endpoint.searchParams.set("client_id",clientId);
  endpoint.searchParams.set("redirect_uri",callback.toString());
  endpoint.searchParams.set("scope",scopes.join(" "));
  endpoint.searchParams.set("state",state);
  endpoint.searchParams.set("nonce",nonce);
  endpoint.searchParams.set("code_challenge",codeChallenge);
  endpoint.searchParams.set("code_challenge_method","S256");
  return {authorizationUrl:endpoint.toString(),state,nonce,codeVerifier,codeChallenge};
}
function validateOidcCallback({state,expectedState,code,nonce,expectedNonce}={}){
  if(!safeEqual(state,expectedState)||!safeEqual(nonce,expectedNonce)||typeof code!=="string"||!code.trim()||code.length>4096)throw new Error("OIDC callback state, nonce, or authorization code is invalid");
  return {code};
}
function createOwnerOidcVerifier({issuer,audience,ownerGroup,groupClaim="groups",jwksUri,resolveJwks,allowedAlgorithms=["RS256"],clock=()=>Date.now(),clockSkewMs=300000,cacheMs=300000,maxJwksBytes=65536}={}){
  const issuerUrl=new URL(issuer);
  const jwksUrl=new URL(jwksUri);
  if(issuerUrl.protocol!=="https:"||jwksUrl.protocol!=="https:"||issuerUrl.username||issuerUrl.password||issuerUrl.hash||jwksUrl.username||jwksUrl.password||jwksUrl.hash||typeof audience!=="string"||!audience.trim()||typeof ownerGroup!=="string"||!ownerGroup.trim()||typeof groupClaim!=="string"||!groupClaim.trim()||typeof resolveJwks!=="function")throw new Error("Owner OIDC configuration is incomplete or unsafe");
  if(!Array.isArray(allowedAlgorithms)||allowedAlgorithms.length<1||allowedAlgorithms.some(alg=>!ALLOWED_ALGORITHMS.has(alg))||new Set(allowedAlgorithms).size!==allowedAlgorithms.length)throw new Error("Owner OIDC signing algorithm allowlist is invalid");
  if(!Number.isInteger(clockSkewMs)||clockSkewMs<0||clockSkewMs>300000||!Number.isInteger(cacheMs)||cacheMs<1000||cacheMs>3600000||!Number.isInteger(maxJwksBytes)||maxJwksBytes<1024||maxJwksBytes>262144)throw new Error("Owner OIDC timing or JWKS size configuration is invalid");
  let cached=null,cachedAt=0;
  async function loadJwks(forceRefresh=false){
    const now=clock();
    if(!forceRefresh&&cached&&now-cachedAt<cacheMs)return cached;
    let response;
    try{response=await resolveJwks({uri:jwksUrl.toString(),forceRefresh,redirect:"error",requireTls:true});}
    catch{if(cached&&now-cachedAt<cacheMs)return cached;throw new Error("Owner OIDC JWKS unavailable; authentication denied");}
    let encodedSize;try{encodedSize=Buffer.byteLength(JSON.stringify(response));}catch{throw new Error("Owner OIDC JWKS response is invalid");}
    if(!response||!Array.isArray(response.keys)||response.keys.length<1||response.keys.length>100||encodedSize>maxJwksBytes||response.keys.some(key=>!key||typeof key!=="object"||Array.isArray(key)))throw new Error("Owner OIDC JWKS response is invalid");
    cached=response;
    cachedAt=now;
    return cached;
  }
  async function verify(token,{expectedNonce=null,requestId=null}={}){
    if(typeof token!=="string"||token.length>16384)throw new Error("Owner OIDC token is invalid");
    const parts=token.split(".");
    if(parts.length!==3)throw new Error("Owner OIDC token is malformed");
    const header=parseJsonPart(parts[0],"header");
    const claims=parseJsonPart(parts[1],"claims");
    if(!header||typeof header!=="object"||!allowedAlgorithms.includes(header.alg)||header.alg==="none"||typeof header.kid!=="string"||header.kid.length>256)throw new Error("Owner OIDC JWT algorithm or key ID is not allowed");
    let jwks=await loadJwks(false);
    let matches=jwks.keys.filter(key=>key.kid===header.kid&&key.use==="sig"&&(!key.alg||key.alg===header.alg)&&(!key.key_ops||(Array.isArray(key.key_ops)&&key.key_ops.length===1&&key.key_ops[0]==="verify"))&&!["d","p","q","dp","dq","qi","oth","k"].some(name=>Object.hasOwn(key,name)));
    if(matches.length!==1){jwks=await loadJwks(true);matches=jwks.keys.filter(key=>key.kid===header.kid&&key.use==="sig"&&(!key.alg||key.alg===header.alg)&&(!key.key_ops||(Array.isArray(key.key_ops)&&key.key_ops.length===1&&key.key_ops[0]==="verify"))&&!["d","p","q","dp","dq","qi","oth","k"].some(name=>Object.hasOwn(key,name)));}
    if(matches.length!==1)throw new Error("Owner OIDC signing key is unavailable or ambiguous");
    const jwk=matches[0];
    const expectedKty=header.alg==="RS256"?"RSA":"EC";
    if(jwk.kty!==expectedKty||(header.alg==="ES256"&&jwk.crv!=="P-256"))throw new Error("Owner OIDC signing key type is invalid");
    let publicKey;
    try{publicKey=crypto.createPublicKey({key:jwk,format:"jwk"});}catch{throw new Error("Owner OIDC signing key is invalid");}
    if(header.alg==="RS256"&&(publicKey.asymmetricKeyDetails?.modulusLength||0)<2048)throw new Error("Owner OIDC RSA signing key is too small");
    const signingInput=Buffer.from(parts[0]+"."+parts[1]);
    const signature=decodePart(parts[2],"signature");
    const valid=header.alg==="RS256"
      ?crypto.verify("RSA-SHA256",signingInput,publicKey,signature)
      :crypto.verify("sha256",signingInput,{key:publicKey,dsaEncoding:"ieee-p1363"},signature);
    if(!valid)throw new Error("Owner OIDC JWT signature verification failed");
    const now=Math.floor(clock()/1000),skew=Math.floor(clockSkewMs/1000);
    if(claims.iss!==issuerUrl.toString()||!(claims.aud===audience||(Array.isArray(claims.aud)&&claims.aud.includes(audience))))throw new Error("Owner OIDC issuer or audience mismatch");
    if((Array.isArray(claims.aud)&&claims.aud.length>1&&claims.azp!==audience)||(claims.azp!==undefined&&claims.azp!==audience))throw new Error("Owner OIDC authorized party mismatch");
    if(!Number.isFinite(claims.exp)||claims.exp<=now-skew||!Number.isFinite(claims.nbf)||claims.nbf>now+skew||!Number.isFinite(claims.iat)||claims.iat>now+skew||claims.iat<now-86400-skew)throw new Error("Owner OIDC token time claims are invalid");
    if(typeof claims.sub!=="string"||!claims.sub.trim()||claims.sub.length>255)throw new Error("Owner OIDC subject is missing or invalid");
    if(typeof expectedNonce!=="string"||!expectedNonce.trim()||!safeEqual(claims.nonce,expectedNonce))throw new Error("Owner OIDC nonce mismatch");
    const groups=claims[groupClaim];
    if(!(groups===ownerGroup||(Array.isArray(groups)&&groups.includes(ownerGroup))))throw new Error("Owner OIDC group authorization denied");
    return Object.freeze({issuer:claims.iss,subject:claims.sub,requestId:typeof requestId==="string"&&requestId.length<=128?requestId:null});
  }
  return {verify};
}
module.exports={ALLOWED_ALGORITHMS,createPkceLoginRequest,validateOidcCallback,createOwnerOidcVerifier};
