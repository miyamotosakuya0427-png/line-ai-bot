"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { POLICY, validatePolicy, evaluateRisk, validateBuy } = require("../core/paper-trading-50k");

test("50,000 JPY allocation reconciles", () => { assert.equal(validatePolicy(), true); assert.equal(POLICY.investmentCapJpy + POLICY.reserveJpy, 50000); });
test("investment cap and stage limits apply", () => { assert.equal(validateBuy({symbol:"BTCJPY",amountJpy:10000,stageIndex:0}).allowed,true); assert.equal(validateBuy({symbol:"BTCJPY",amountJpy:15000,stageIndex:0}).reason,"STAGE_LIMIT"); assert.equal(validateBuy({symbol:"BTCJPY",amountJpy:10000,investedJpy:30000,stageIndex:2}).reason,"INVESTMENT_CAP"); });
test("2,500 JPY total loss halts new buys including fees", () => { const risk=evaluateRisk({realizedPnlJpy:-1800,unrealizedPnlJpy:-500,feesJpy:200}); assert.equal(risk.lossJpy,2500); assert.equal(risk.halted,true); assert.equal(validateBuy({symbol:"ETHJPY",amountJpy:10000,riskState:risk}).reason,"LOSS_LIMIT_REACHED"); });
test("per-asset allocation caps are enforced", () => { assert.equal(validateBuy({symbol:"BTCJPY",amountJpy:10000,assetInvestedJpy:10000,stageIndex:0}).reason,"ASSET_ALLOCATION_CAP"); });
test("unsupported assets and live execution are blocked", () => { assert.equal(validateBuy({symbol:"BTCUSDT",amountJpy:10000}).reason,"UNSUPPORTED_SYMBOL"); assert.equal(POLICY.liveOrders,false); });
