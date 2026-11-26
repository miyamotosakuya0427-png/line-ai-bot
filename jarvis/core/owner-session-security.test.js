"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {
  createOwnerSessionCookie,clearOwnerSessionCookie,createCsrfToken,verifyCsrfToken,
  evaluateOwnerSessionLifetime,shouldRotateOwnerSession
}=require("./owner-session-security");

test("Owner session cookie is host-only, Secure, HttpOnly and SameSite Lax",()=>{
  const cookie=createOwnerSessionCookie({sessionId:"s".repeat(43)});
  assert.match(cookie,/^__Host-onejarvis_owner=/);
  assert.match(cookie,/; Path=\//);
  assert.match(cookie,/; Secure/);
  assert.match(cookie,/; HttpOnly/);
  assert.match(cookie,/; SameSite=Lax/);
  assert.doesNotMatch(cookie,/Domain=/);
  assert.match(clearOwnerSessionCookie(),/Max-Age=0/);
});

test("Owner session cookie rejects insecure, weak or overlong policy",()=>{
  assert.throws(()=>createOwnerSessionCookie({sessionId:"x".repeat(42)}));
  assert.throws(()=>createOwnerSessionCookie({sessionId:"x".repeat(43),secure:false}));
  assert.throws(()=>createOwnerSessionCookie({sessionId:"x".repeat(43),sameSite:"None"}));
  assert.throws(()=>createOwnerSessionCookie({sessionId:"x".repeat(43),maxAgeSeconds:86400}));
});

test("CSRF tokens are random opaque values and compared in constant time",()=>{
  const token=createCsrfToken();
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyCsrfToken(token,token),true);
  assert.equal(verifyCsrfToken(token,token.slice(0,-1)+(token.endsWith("A")?"B":"A")),false);
  assert.equal(verifyCsrfToken(token,undefined),false);
});

test("Owner session expires on absolute TTL, idle timeout or revocation",()=>{
  const now=10000000;
  const base={createdAt:now-1000,lastSeenAt:now-1000,now,absoluteTtlMs:3600000,idleTimeoutMs:900000};
  assert.equal(evaluateOwnerSessionLifetime(base).valid,true);
  assert.equal(evaluateOwnerSessionLifetime({...base,createdAt:now-3600000}).reason,"absolute_expiry");
  assert.equal(evaluateOwnerSessionLifetime({...base,lastSeenAt:now-900000}).reason,"idle_timeout");
  assert.equal(evaluateOwnerSessionLifetime({...base,revokedAt:now}).reason,"revoked");
  assert.equal(evaluateOwnerSessionLifetime({...base,lastSeenAt:now+1}).reason,"invalid_session_metadata");
});

test("Owner session rotates after authentication and privilege changes",()=>{
  assert.equal(shouldRotateOwnerSession({authenticated:true}),true);
  assert.equal(shouldRotateOwnerSession({privilegeChanged:true}),true);
  assert.equal(shouldRotateOwnerSession({sessionAgeMs:900000}),true);
  assert.equal(shouldRotateOwnerSession({sessionAgeMs:1000}),false);
});
