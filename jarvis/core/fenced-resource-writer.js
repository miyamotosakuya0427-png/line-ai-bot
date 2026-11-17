"use strict";

function createFencedResourceWriter({registry,adapter,allowedScopes=[]}={}){
  if(!registry||typeof registry.assertLeaseCurrent!=="function")throw new Error("A lease-verifying Task Registry is required");
  if(!adapter||typeof adapter.writeFenced!=="function")throw new Error("A fencing-aware resource adapter is required");
  if(!Array.isArray(allowedScopes)||allowedScopes.length<1||allowedScopes.length>100||allowedScopes.some(x=>typeof x!=="string"||!/^[a-z][a-z0-9:_-]{1,127}$/.test(x)))throw new Error("Explicit resource operation scopes are required");
  const scopeSet=new Set(allowedScopes);
  return async function write({lease,resourceKey,operationId,operationScope,payload}={}){
    if(!lease||typeof lease.resourceKey!=="string"||lease.resourceKey!==resourceKey||
      typeof lease.ownerId!=="string"||!Number.isSafeInteger(lease.fencingToken)||
      typeof lease.token!=="string"||typeof lease.expiresAt!=="string"||
      typeof operationId!=="string"||!operationId.trim()||operationId.length>200||
      typeof operationScope!=="string"||!scopeSet.has(operationScope)){
      throw new Error("A valid resource lease, permitted operation scope, and idempotency key are required");
    }
    // The preflight check rejects already-stale leases. The target adapter must
    // atomically enforce the fencing token, expiry, operation scope, idempotency
    // key, and append a durable audit record with the write. If it cannot do
    // all of these at the target boundary, it must fail closed.
    await registry.assertLeaseCurrent({lease});
    return adapter.writeFenced({
      resourceKey,ownerId:lease.ownerId,fencingToken:lease.fencingToken,
      leaseExpiresAt:lease.expiresAt,operationId,operationScope,payload,
      audit:{actorId:lease.ownerId,resourceKey,operationScope,operationId,fencingToken:lease.fencingToken}
    });
  };
}
module.exports={createFencedResourceWriter};
