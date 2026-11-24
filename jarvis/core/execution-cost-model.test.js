"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {estimateExecutionCost}=require("./execution-cost-model");

test("returns complete maker cost estimate when every component is known",()=>{
 const result=estimateExecutionCost({side:"buy",quantity:2,referencePrice:1000,executionPrice:1001,makerFeeRate:0.001,takerFeeRate:0.002,liquidityRole:"maker",spreadBps:2,slippageBps:3,impactBps:1});
 assert.equal(result.complete,true);
 assert.equal(result.costs.feeYen,2);
 assert.equal(result.costs.spreadYen,0.2);
 assert.equal(result.costs.slippageYen,0.6);
 assert.equal(result.costs.impactYen,0.2);
 assert.equal(result.costs.executionDifferenceYen,2);
 assert.equal(result.zeroCostAssumed,false);
});
test("keeps unknown costs null and never assumes zero",()=>{
 const result=estimateExecutionCost({side:"sell",quantity:1,referencePrice:1000,liquidityRole:"taker"});
 assert.equal(result.complete,false);
 assert.equal(result.costs.feeYen,null);
 assert.equal(result.costs.spreadYen,null);
 assert.ok(result.unknown.length>0);
 assert.equal(result.zeroCostAssumed,false);
});
