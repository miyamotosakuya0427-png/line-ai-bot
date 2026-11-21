"use strict";

class TradingRuleError extends Error {
  constructor(message, code = "TRADING_RULE_REJECTED") { super(message); this.name = "TradingRuleError"; this.code = code; }
}
function finitePositive(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TradingRuleError("Invalid " + field, "INVALID_FILTER");
  return n;
}
function normalizeFilters(symbolInfo, provenance = {}) {
  if (!symbolInfo || !Array.isArray(symbolInfo.filters)) throw new TradingRuleError("Missing exchange filters", "UNVERIFIED_FILTERS");
  const byType = Object.fromEntries(symbolInfo.filters.map(f => [f.filterType, f]));
  const price = byType.PRICE_FILTER;
  const lot = byType.LOT_SIZE;
  const marketLot = byType.MARKET_LOT_SIZE;
  const notional = byType.NOTIONAL || byType.MIN_NOTIONAL;
  const verified = provenance.venue === "BINANCE_JAPAN" &&
    provenance.accountContextVerified === true &&
    provenance.sourceHostVerified === true;
  const rules = {
    symbol: symbolInfo.symbol,
    status: symbolInfo.status || "UNKNOWN",
    spotAllowed: symbolInfo.isSpotTradingAllowed === true,
    provenance: {
      venue: provenance.venue || "UNKNOWN",
      sourceHost: provenance.sourceHost || null,
      accountContextVerified: provenance.accountContextVerified === true,
      sourceHostVerified: provenance.sourceHostVerified === true
    },
    verification: verified ? "VERIFIED" : "UNVERIFIED",
    price: price ? {
      min: finitePositive(price.minPrice, "PRICE_FILTER.minPrice"),
      max: finitePositive(price.maxPrice, "PRICE_FILTER.maxPrice"),
      tickSize: finitePositive(price.tickSize, "PRICE_FILTER.tickSize")
    } : null,
    lot: lot ? {
      min: finitePositive(lot.minQty, "LOT_SIZE.minQty"),
      max: finitePositive(lot.maxQty, "LOT_SIZE.maxQty"),
      stepSize: finitePositive(lot.stepSize, "LOT_SIZE.stepSize")
    } : null,
    marketLot: marketLot ? {
      min: finitePositive(marketLot.minQty, "MARKET_LOT_SIZE.minQty"),
      max: finitePositive(marketLot.maxQty, "MARKET_LOT_SIZE.maxQty"),
      stepSize: finitePositive(marketLot.stepSize, "MARKET_LOT_SIZE.stepSize")
    } : null,
    notional: notional ? {
      min: finitePositive(notional.minNotional, "MIN_NOTIONAL.minNotional"),
      applyToMarket: notional.applyToMarket === true || notional.applyMinToMarket === true,
      max: notional.maxNotional && Number(notional.maxNotional) > 0 ? Number(notional.maxNotional) : null,
      applyMaxToMarket: notional.applyMaxToMarket === true
    } : null
  };
  if (!rules.price || !rules.lot || !rules.marketLot || !rules.notional) {
    throw new TradingRuleError("Required price, lot, market-lot or notional filter is missing", "UNVERIFIED_FILTERS");
  }
  return rules;
}
function decimalParts(value) {
  const s = String(value).toLowerCase();
  if (s.includes("e")) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new TradingRuleError("Invalid decimal", "INVALID_ORDER_VALUE");
    return decimalParts(n.toFixed(12).replace(/0+$/, "").replace(/\.$/, ""));
  }
  const [whole, fraction = ""] = s.split(".");
  return { digits: BigInt((whole || "0") + fraction), scale: fraction.length };
}
function aligned(value, step) {
  const a = decimalParts(value), b = decimalParts(step), scale = Math.max(a.scale, b.scale);
  const av = a.digits * (10n ** BigInt(scale - a.scale));
  const bv = b.digits * (10n ** BigInt(scale - b.scale));
  return bv > 0n && av % bv === 0n;
}
function validateOrder({ side, type, price, quantity }, rules) {
  if (!rules || rules.verification !== "VERIFIED") throw new TradingRuleError("Binance Japan account-specific trading rules are unverified", "UNVERIFIED_JAPAN_RULES");
  if (rules.status !== "TRADING" || !rules.spotAllowed) throw new TradingRuleError("Pair is not active spot trading", "PAIR_NOT_TRADABLE");
  if (!["BUY", "SELL"].includes(side) || !["LIMIT", "MARKET"].includes(type)) throw new TradingRuleError("Unsupported order intent", "UNSUPPORTED_ORDER");
  const q = finitePositive(quantity, "quantity");
  const qtyRule = type === "MARKET" ? rules.marketLot : rules.lot;
  if (!qtyRule || q < qtyRule.min || q > qtyRule.max || !aligned(quantity, qtyRule.stepSize)) {
    throw new TradingRuleError("Quantity violates " + type + " lot-size rules", "LOT_SIZE_VIOLATION");
  }
  let p = null;
  if (type === "LIMIT") {
    p = finitePositive(price, "price");
    if (p < rules.price.min || p > rules.price.max || !aligned(price, rules.price.tickSize)) {
      throw new TradingRuleError("Price violates PRICE_FILTER", "PRICE_FILTER_VIOLATION");
    }
  } else if (price !== undefined && price !== null) {
    throw new TradingRuleError("Market order must not supply a limit price", "UNSUPPORTED_ORDER");
  }
  if (type === "LIMIT" || rules.notional.applyToMarket) {
    const notional = (p || 0) * q;
    if (notional < rules.notional.min || (rules.notional.max !== null && notional > rules.notional.max)) {
      throw new TradingRuleError("Order violates notional filter", "NOTIONAL_VIOLATION");
    }
  } else if (type === "MARKET" && !rules.notional.applyToMarket) {
    // A market order whose notional filter is not applicable is not blocked by that filter.
  }
  return { valid: true, symbol: rules.symbol, side, type, quantity: q, estimatedNotional: p === null ? null : p * q, executionEnabled: false };
}
module.exports = { TradingRuleError, normalizeFilters, validateOrder };
