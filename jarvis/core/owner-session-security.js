"use strict";
const crypto = require("node:crypto");

const DEFAULT_COOKIE_NAME = "__Host-onejarvis_owner";

function createOwnerSessionCookie({ sessionId, name=DEFAULT_COOKIE_NAME, maxAgeSeconds=900, secure=true, sameSite="Lax" }={}) {
  if (name !== DEFAULT_COOKIE_NAME || secure !== true || !/^[A-Za-z0-9_-]{43,128}$/.test(sessionId || "") ||
      !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 60 || maxAgeSeconds > 3600 ||
      !["Strict","Lax"].includes(sameSite)) {
    throw new Error("Invalid Owner session cookie policy");
  }
  return name + "=" + sessionId + "; Path=/; Max-Age=" + maxAgeSeconds + "; Secure; HttpOnly; SameSite=" + sameSite;
}

function clearOwnerSessionCookie() {
  return DEFAULT_COOKIE_NAME + "=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax";
}

function createCsrfToken(randomBytes=crypto.randomBytes) {
  return randomBytes(32).toString("base64url");
}

function verifyCsrfToken(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(expected) || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  const a=Buffer.from(expected), b=Buffer.from(supplied);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

function evaluateOwnerSessionLifetime({ createdAt, lastSeenAt, now=Date.now(), absoluteTtlMs=8*60*60*1000, idleTimeoutMs=15*60*1000, revokedAt=null }={}) {
  if (![createdAt,lastSeenAt,now,absoluteTtlMs,idleTimeoutMs].every(Number.isFinite) ||
      createdAt > lastSeenAt || lastSeenAt > now || absoluteTtlMs < 60000 ||
      idleTimeoutMs < 60000 || idleTimeoutMs > absoluteTtlMs) {
    return Object.freeze({ valid:false, reason:"invalid_session_metadata" });
  }
  if (revokedAt !== null) return Object.freeze({ valid:false, reason:"revoked" });
  if (now-createdAt >= absoluteTtlMs) return Object.freeze({ valid:false, reason:"absolute_expiry" });
  if (now-lastSeenAt >= idleTimeoutMs) return Object.freeze({ valid:false, reason:"idle_timeout" });
  return Object.freeze({ valid:true, reason:"active" });
}

function shouldRotateOwnerSession({ authenticated=false, privilegeChanged=false, sessionAgeMs=0, rotateAfterMs=15*60*1000 }={}) {
  if (authenticated || privilegeChanged) return true;
  return Number.isFinite(sessionAgeMs) && Number.isFinite(rotateAfterMs) && rotateAfterMs>0 && sessionAgeMs>=rotateAfterMs;
}

module.exports = {
  DEFAULT_COOKIE_NAME,
  createOwnerSessionCookie,
  clearOwnerSessionCookie,
  createCsrfToken,
  verifyCsrfToken,
  evaluateOwnerSessionLifetime,
  shouldRotateOwnerSession
};
