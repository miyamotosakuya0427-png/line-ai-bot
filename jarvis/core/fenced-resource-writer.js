"use strict";

function createFencedResourceWriter({registry,adapter}={}){
  if(!registry||typeof registry.assertLeaseCurrent!=="function")throw new Error("A lease-verifying Task Registry is required");
  if(!adapter||typeof adapter.writeFenced!=="function")throw new Error("A fencing-aware resource adapter is required");
  return async function write({lease,resourceKey,operationId,payload}={}){
    if(!lease||typeof lease.resourceKey!=="string"||lease.resourceKey!==resourceKey||
      typeof lease.ownerId!=="string"||!Number.isSafeInteger(lease.fencingToken)||
      typeof lease.token!=="string"||typeof lease.expiresAt!=="string"||
      typeof operationId!=="string"||!operationId.trim()||operationId.length>200){
      throw new Error("A valid resource lease and idempotency key are required");
    }
    // Verify immediately before crossing the adapter boundary. The adapter
    // must atomically enforce fencingToken monotonicity and operationId
    // idempotency; a preflight check alone cannot fence an already-running
    // stale network request.
    await registry.assertLeaseCurrent({lease});
    return adapter.writeFenced({
      resourceKey,ownerId:lease.ownerId,fencingToken:lease.fencingToken,
      leaseExpiresAt:lease.expiresAt,operationId,payload
    });
  };
}
module.exports={createFencedResourceWriter};
