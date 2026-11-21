"use strict";

const POLICY = Object.freeze({
  initialCapitalJpy: 50000, investmentCapJpy: 35000, reserveJpy: 15000,
  lossStopJpy: 2500, stageBudgetsJpy: [10000, 15000, 10000],
  targetAllocationsJpy: { BTC: 17500, ETH: 10500, SOL: 7000 },
  symbols: { BTC: "BTCJPY", ETH: "ETHJPY", SOL: "SOLJPY" },
  leverage: false, margin: false, futures: false, shortSelling: false, liveOrders: false
});

function validatePolicy(policy = POLICY) {
  const allocationTotal = Object.values(policy.targetAllocationsJpy).reduce((a, b) => a + b, 0);
  const stageTotal = policy.stageBudgetsJpy.reduce((a, b) => a + b, 0);
  if (policy.initialCapitalJpy !== 50000 || policy.investmentCapJpy !== 35000 || policy.reserveJpy !== 15000 ||
      allocationTotal !== 35000 || stageTotal !== 35000 || policy.investmentCapJpy + policy.reserveJpy !== policy.initialCapitalJpy ||
      policy.leverage || policy.margin || policy.futures || policy.shortSelling || policy.liveOrders) {
    throw new Error("Invalid or unsafe 50,000 JPY paper-trading policy");
  }
  return true;
}
function evaluateRisk({ realizedPnlJpy = 0, unrealizedPnlJpy = 0, feesJpy = 0, investedJpy = 0 }, policy = POLICY) {
  validatePolicy(policy);
  const totalPnl = realizedPnlJpy + unrealizedPnlJpy - feesJpy;
  const lossJpy = Math.max(0, -totalPnl);
  const halted = lossJpy >= policy.lossStopJpy;
  return { totalPnlJpy: totalPnl, lossJpy, halted, reason: halted ? "LOSS_LIMIT_REACHED" : null,
    remainingInvestmentCapacityJpy: Math.max(0, policy.investmentCapJpy - investedJpy),
    reserveJpy: policy.reserveJpy, liveOrdersEnabled: false };
}
function validateBuy({ symbol, amountJpy, investedJpy = 0, assetInvestedJpy = 0, riskState, stageIndex = 0 }, policy = POLICY) {
  validatePolicy(policy);
  const asset = Object.keys(policy.symbols).find(k => policy.symbols[k] === symbol);
  if (!asset) return { allowed: false, reason: "UNSUPPORTED_SYMBOL" };
  if (!Number.isInteger(amountJpy) || amountJpy <= 0) return { allowed: false, reason: "INVALID_AMOUNT" };
  if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= policy.stageBudgetsJpy.length ||
      amountJpy > policy.stageBudgetsJpy[stageIndex]) return { allowed: false, reason: "STAGE_LIMIT" };
  if (riskState?.halted) return { allowed: false, reason: "LOSS_LIMIT_REACHED" };
  if (investedJpy + amountJpy > policy.investmentCapJpy) return { allowed: false, reason: "INVESTMENT_CAP" };
  if (!Number.isFinite(assetInvestedJpy) || assetInvestedJpy < 0 || assetInvestedJpy + amountJpy > policy.targetAllocationsJpy[asset]) return { allowed: false, reason: "ASSET_ALLOCATION_CAP" };
  return { allowed: true, reason: null, liveOrdersEnabled: false };
}
module.exports = { POLICY, validatePolicy, evaluateRisk, validateBuy };
