/*
 * Core math for USDT/USDC-margined perpetual futures on several exchanges
 * (one-way mode, single position). Pure functions, no DOM — loaded by the browser
 * as window.PerpCalc and by Node tests.
 *
 * A bracket (margin tier) is a compact array:
 *   [floor, cap, maxLeverage, maintMarginRate, maintDeduction]
 * floor/cap are in USDT position value (basis 'value') or in coins (basis 'qty').
 * maintenance margin = value * mmr - deduction.
 *
 * Each exchange is described by a model:
 *   basis   'value' | 'qty'     what the tier boundaries measure
 *   tierAt  'liq'   | 'entry'   value-based tiers looked up at the liquidation price or at entry
 *   mmAt    'liq'   | 'entry'   maintenance margin on the value at the liquidation price, or fixed at entry
 *   liqFee  number              fee rate the exchange adds to the maintenance rate in its formula
 *   extraFee number             Bybit only: added margin counts as extra / (1 - side * fee)
 *   openFeeFromMargin bool      Binance: the opening fee is taken out of the isolated margin
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerpCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FLOOR = 0, CAP = 1, LEV = 2, MMR = 3, CUM = 4;
  var DEFAULT_MODEL = { basis: 'value', tierAt: 'liq', mmAt: 'liq', liqFee: 0, extraFee: 0 };

  function sideSign(side) { return side === 'short' ? -1 : 1; }
  function modelOf(o) { return o.model || DEFAULT_MODEL; }
  function last(br) { return br[br.length - 1]; }

  /** What the tiers are measured in, for a position of qty coins at price. */
  function tierKey(model, qty, price) { return (model || DEFAULT_MODEL).basis === 'qty' ? qty : qty * price; }

  /** Bracket containing this key, or null if it exceeds the largest tier. */
  function bracketFor(brackets, key) {
    for (var i = 0; i < brackets.length; i++) {
      var b = brackets[i];
      if (key >= b[FLOOR] && key < b[CAP]) return b;
    }
    return null;
  }

  function maxKey(brackets) { return last(brackets)[CAP]; }

  /** Maintenance margin of a position worth `value` in tier b. */
  function mmFor(b, value) { return value * b[MMR] - b[CUM]; }

  /**
   * Liquidation price for one position.
   * wb: margin behind the position (isolated margin incl. any added margin, or wallet balance in cross).
   * Returns { price, none, bracket }; none=true means a long cannot be liquidated.
   */
  function liquidationPrice(o) {
    var m = modelOf(o), s = sideSign(o.side), qty = o.qty, entry = o.entry, wb = o.wb, br = o.brackets;
    var fl = m.liqFee || 0;
    if (!(qty > 0) || !(entry > 0) || !(wb >= 0)) return null;

    // MEXC, BingX: maintenance margin fixed at the entry value.
    if (m.mmAt === 'entry') {
      var be = bracketFor(br, tierKey(m, qty, entry)) || last(br);
      var pe = entry - s * (wb - mmFor(be, qty * entry)) / qty;
      if (s === 1 && pe <= 0) return { price: 0, none: true, bracket: be };
      return { price: pe, none: false, bracket: be };
    }

    // Solve  wb + s*qty*(P - entry) = qty*P*(mmr + fl) - cum  for P.
    var solve = function (b) { return (wb + b[CUM] - s * qty * entry) / (qty * (b[MMR] + fl) - s * qty); };

    // Tier fixed by quantity (OKX, MEXC) or by entry value (KuCoin).
    if (m.basis === 'qty' || m.tierAt === 'entry') {
      var bf = bracketFor(br, tierKey(m, qty, entry)) || last(br);
      var pf = solve(bf);
      if (s === 1 && pf <= 0) return { price: 0, none: true, bracket: bf };
      return { price: pf, none: false, bracket: bf };
    }

    // Tier looked up at the liquidation price: keep the solution that lands in its own tier.
    for (var i = 0; i < br.length; i++) {
      var b = br[i];
      if (qty * (b[MMR] + fl) - s * qty === 0) continue;
      var p = solve(b);
      if (s === 1 && p <= 0) {
        if (b[FLOOR] === 0) return { price: 0, none: true, bracket: b };
        continue;
      }
      var n = qty * p;
      // The last tier is open-ended here: a short's value can grow past the cap as price rises.
      if (n >= b[FLOOR] && (n < b[CAP] || i === br.length - 1)) return { price: p, none: false, bracket: b };
    }
    var bx = bracketFor(br, qty * entry) || last(br);
    var px = solve(bx);
    return { price: Math.max(px, 0), none: px <= 0, bracket: bx };
  }

  /** Margin that backs an isolated position, applying Bybit's adjustment for added margin. */
  function isolatedMargin(m, side, initialMargin, extra) {
    extra = extra || 0;
    if (extra && m.extraFee) extra = extra / (1 - sideSign(side) * m.extraFee);
    return initialMargin + extra;
  }

  /** Full liquidation report for the liquidation calculator page. */
  function liquidation(o) {
    var m = modelOf(o), qty = o.qty, entry = o.entry, lev = o.leverage, br = o.brackets;
    var notional = qty * entry;
    var initialMargin = notional / lev;
    var openFee = o.mode !== 'cross' && m.openFeeFromMargin && o.feeOpen > 0 ? notional * o.feeOpen : 0;
    var wb = o.mode === 'cross' ? o.walletBalance : isolatedMargin(m, o.side, initialMargin, o.extraMargin) - openFee;
    var key = tierKey(m, qty, entry);
    var entryBracket = bracketFor(br, key);
    var warnings = [];
    if (!entryBracket) return { error: 'max_position', key: key, limit: maxKey(br), basis: m.basis, notional: notional, warnings: warnings };
    if (entryBracket[LEV] && lev > entryBracket[LEV]) warnings.push({ code: 'leverage', allowed: entryBracket[LEV] });
    if (o.mode === 'cross' && o.walletBalance < initialMargin) warnings.push({ code: 'balance', needed: initialMargin });
    var liq = liquidationPrice({ side: o.side, qty: qty, entry: entry, wb: wb, brackets: br, model: m });
    return {
      notional: notional,
      initialMargin: initialMargin,
      marginUsed: wb,
      openFee: openFee,
      maintMargin: mmFor(entryBracket, notional),
      entryBracket: entryBracket,
      liq: liq,
      distance: liq.none ? null : Math.abs(liq.price - entry) / entry,
      warnings: warnings
    };
  }

  function decimals(step) {
    var s = String(step);
    if (s.indexOf('e-') >= 0) return Number(s.split('e-')[1]);
    var i = s.indexOf('.');
    return i < 0 ? 0 : s.replace(/0+$/, '').length - i - 1;
  }

  function roundDown(x, step) {
    if (!(step > 0)) return x;
    var d = decimals(step);
    return Number((Math.floor(x / step + 1e-9) * step).toFixed(d));
  }

  /**
   * Position size from risk: how much to buy/sell so that hitting the stop loses `risk` (fees included).
   * Also checks that liquidation sits beyond the stop and finds the highest leverage where it does.
   */
  function positionSize(o) {
    var m = modelOf(o), s = sideSign(o.side), entry = o.entry, stop = o.stop, br = o.brackets;
    if (!(entry > 0) || !(stop > 0) || !(o.risk > 0)) return null;
    if ((s === 1 && stop >= entry) || (s === -1 && stop <= entry)) return { error: 'stop_side' };
    var lossPerUnit = Math.abs(entry - stop) + entry * o.feeOpen + stop * o.feeClose;
    var rawQty = o.risk / lossPerUnit;
    var qty = roundDown(rawQty, o.step);
    if (o.minQty && qty < o.minQty) return { error: 'min_qty', minQty: o.minQty, rawQty: rawQty };
    var notional = qty * entry;
    var b = bracketFor(br, tierKey(m, qty, entry));
    if (!b) return { error: 'max_position', limit: maxKey(br), basis: m.basis, notional: notional };
    var lev = o.leverage;
    var margin = notional / lev;
    var warnings = [];
    if (b[LEV] && lev > b[LEV]) warnings.push({ code: 'leverage', allowed: b[LEV] });
    if (o.balance > 0 && margin > o.balance) warnings.push({ code: 'balance', needed: margin });
    var openFee = m.openFeeFromMargin && o.feeOpen > 0 ? notional * o.feeOpen : 0;
    var liq = liquidationPrice({ side: o.side, qty: qty, entry: entry, wb: margin - openFee, brackets: br, model: m });
    var liqBeforeStop = !liq.none && (s === 1 ? liq.price >= stop : liq.price <= stop);
    if (liqBeforeStop) warnings.push({ code: 'liq_before_stop' });
    var safeLev = 0, top = b[LEV] || o.maxLeverage || 125;
    for (var L = top; L >= 1; L--) {
      var l = liquidationPrice({ side: o.side, qty: qty, entry: entry, wb: notional / L - openFee, brackets: br, model: m });
      if (l.none || (s === 1 ? l.price < stop : l.price > stop)) { safeLev = L; break; }
    }
    return {
      qty: qty, notional: notional, margin: margin, risk: qty * lossPerUnit,
      riskPctOfBalance: o.balance > 0 ? qty * lossPerUnit / o.balance : null,
      stopDistance: Math.abs(entry - stop) / entry,
      liq: liq, liqBeforeStop: liqBeforeStop, safeLeverage: safeLev, bracket: b, warnings: warnings
    };
  }

  /** Average entry of several fills [{price, qty}] (qty in coins). */
  function averageEntry(fills) {
    var q = 0, v = 0;
    (fills || []).forEach(function (f) { if (f && f.qty > 0 && f.price > 0) { q += f.qty; v += f.qty * f.price; } });
    return q > 0 ? { qty: q, value: v, price: v / q } : null;
  }

  /**
   * Size to add at `price` so a position of q0 coins at average e0 ends at average `target`.
   * The target has to lie strictly between the current average and the add price; otherwise null.
   */
  function sizeForTargetAverage(q0, e0, price, target) {
    if (!(q0 > 0) || !(e0 > 0) || !(price > 0) || !(target > 0) || target === price) return null;
    var x = q0 * (e0 - target) / (target - price);
    return x > 0 && isFinite(x) ? x : null;
  }

  /** Profit and loss with fees, ROE on initial margin, and break-even exit price. */
  function pnl(o) {
    var s = sideSign(o.side), q = o.qty, e = o.entry, x = o.exit;
    if (!(q > 0) || !(e > 0) || !(x > 0)) return null;
    var gross = s * q * (x - e);
    var feeOpen = q * e * o.feeOpen, feeClose = q * x * o.feeClose;
    var net = gross - feeOpen - feeClose;
    var margin = q * e / o.leverage;
    var breakEven = s === 1 ? e * (1 + o.feeOpen) / (1 - o.feeClose) : e * (1 - o.feeOpen) / (1 + o.feeClose);
    return {
      gross: gross, feeOpen: feeOpen, feeClose: feeClose, fees: feeOpen + feeClose, net: net,
      margin: margin, roe: net / margin, priceMove: (x - e) / e, breakEven: breakEven, notional: q * e
    };
  }

  return {
    DEFAULT_MODEL: DEFAULT_MODEL, tierKey: tierKey, bracketFor: bracketFor, maxKey: maxKey, mmFor: mmFor,
    liquidationPrice: liquidationPrice, isolatedMargin: isolatedMargin, liquidation: liquidation,
    positionSize: positionSize, pnl: pnl, averageEntry: averageEntry, sizeForTargetAverage: sizeForTargetAverage, roundDown: roundDown, decimals: decimals
  };
});
