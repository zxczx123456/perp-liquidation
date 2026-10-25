'use strict';
/**
 * perp-liquidation: liquidation price, position size, PnL and average entry for USDT/USDC-margined
 * perpetual futures, using each exchange's own published formula and the contract's margin tiers.
 * Formulas maintained by PerpTiers (https://perptiers.com), where every exchange is also a free calculator.
 */
const calc = require('./calc.js');
const models = require('./models.json');

/** The liquidation model for an exchange id: binance, okx, bybit, gate, bitget, hyperliquid, mexc, kucoin, bingx. */
function model(exchange) {
  const e = models.exchanges[exchange];
  if (!e) throw new Error(`unknown exchange "${exchange}"; known: ${Object.keys(models.exchanges).join(', ')}`);
  return e.model;
}

/** Default (non-VIP) maker/taker fee rates for an exchange, as checked on models.feesChecked. */
function fees(exchange) {
  model(exchange);
  return models.exchanges[exchange].fees;
}

module.exports = Object.assign({}, calc, { model, fees, exchanges: Object.keys(models.exchanges), models });
