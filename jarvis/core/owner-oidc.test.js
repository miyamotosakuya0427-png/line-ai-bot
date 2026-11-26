"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {createPkceLoginRequest,validateOidcCallback,createOwnerOidcVerifier}=require("./owner-oidc");

const now=Date.parse("2026-11-26T12:00:00.000Z");
const {privateKey,publicKey}=crypto.generateKeyPairSync("rsa",{modulusLength:2048});
const jwk={...publicKey.export({format:"jwk"}),kid:"mock-key-1",alg:"RS256",use:"sig"};
function token(claimOverrides={},headerOverrides={}){
 const header=Buffer.from(JSON.stringify({alg:"RS256",kid:"mock-key-1",typ:"JWT",...headerOverrides})).toString("base64url");
 const claims=Buffer.from(JSON.stringify({iss:"https://mock-idp.example/",aud:"one-jarvis-test-client",sub:"owner-subject-1",iat:Math.floor(now/1000)-30,nbf:Math.floor(now/1000)-30,exp:Math.floor(now/1000)+600,nonce:"nonce-expected",groups:["one-jarvis-owners"],...claimOverrides})).toString("base64url");
 const input=header+"."+claims;
 return input+"."+crypto.sign("RSA-SHA256",Buffer.from(input),privateKey).toString("base64url");
}
function verifier({resolveJwks=async()=>({keys:[jwk]})}={}){
 return createOwnerOidcVerifier({issuer:"https://mock-idp.example/",audience:"one-jarvis-test-client",ownerGroup:"one-jarvis-owners",groupClaim:"groups",jwksUri:"https://mock-idp.example/.well-known/jwks.json",resolveJwks,clock:()=>now,allowedAlgorithms:["RS256"]});
}

test("Owner OIDC verifies signed Mock IdP JWT and returns only verified issuer and subject",async()=>{
 const identity=await verifier().verify(token(),{expectedNonce:"nonce-expected",requestId:"request-123"});
 assert.deepEqual(identity,{issuer:"https://mock-idp.example/",subject:"owner-subject-1",requestId:"request-123"});
 assert.equal(Object.hasOwn(identity,"token"),false);
});

test("Owner OIDC rejects forged signatures, issuer, audience, expiry, not-before, nonce and Owner group",async()=>{
 const check=verifier();
 await assert.rejects(check.verify(token(),{expectedNonce:"wrong"}),/nonce mismatch/);
 await assert.rejects(check.verify(token({iss:"https://attacker.example/"})),/issuer or audience mismatch/);
 await assert.rejects(check.verify(token({aud:"other-client"})),/issuer or audience mismatch/);
 await assert.rejects(check.verify(token({exp:Math.floor(now/1000)-600})),/time claims/);
 await assert.rejects(check.verify(token({nbf:Math.floor(now/1000)+900})),/time claims/);
 await assert.rejects(check.verify(token({groups:["not-owner"]})),/group authorization denied/);
 const parts=token().split(".");parts[1]=Buffer.from(JSON.stringify({sub:"attacker"})).toString("base64url");
 await assert.rejects(check.verify(parts.join(".")),/signature verification failed/);
});

test("Owner OIDC fails closed on unavailable or ambiguous JWKS keys",async()=>{
 await assert.rejects(verifier({resolveJwks:async()=>{throw new Error("network failure");}}).verify(token()),/JWKS unavailable/);
 await assert.rejects(verifier({resolveJwks:async()=>({keys:[jwk,{...jwk}]})}).verify(token()),/unavailable or ambiguous/);
});

test("Owner OIDC rejects unapproved signing algorithms",async()=>{
 await assert.rejects(verifier().verify(token({}, {alg:"none"})),/algorithm or key ID/);
 assert.throws(()=>createOwnerOidcVerifier({issuer:"https://mock-idp.example/",audience:"client",ownerGroup:"owners",jwksUri:"https://mock-idp.example/jwks",resolveJwks:async()=>({keys:[jwk]}),allowedAlgorithms:["HS256"]}),/algorithm allowlist/);
});

test("OIDC login request uses PKCE S256, state and nonce; callback validates both",()=>{
 const login=createPkceLoginRequest({authorizationEndpoint:"https://mock-idp.example/authorize",clientId:"client",redirectUri:"https://jarvis.example/callback"});
 const url=new URL(login.authorizationUrl);
 assert.equal(url.searchParams.get("code_challenge_method"),"S256");
 assert.equal(url.searchParams.get("code_challenge"),login.codeChallenge);
 assert.equal(login.codeChallenge,crypto.createHash("sha256").update(login.codeVerifier).digest("base64url"));
 assert.equal(url.searchParams.get("state"),login.state);
 assert.equal(url.searchParams.get("nonce"),login.nonce);
 assert.deepEqual(validateOidcCallback({state:login.state,expectedState:login.state,nonce:login.nonce,expectedNonce:login.nonce,code:"mock-auth-code"}),{code:"mock-auth-code"});
 assert.throws(()=>validateOidcCallback({state:"wrong",expectedState:login.state,nonce:login.nonce,expectedNonce:login.nonce,code:"mock-auth-code"}),/callback state/);
});
