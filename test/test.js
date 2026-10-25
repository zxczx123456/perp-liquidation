// Run: node tests/test_calc.js
const assert = require('assert');
const C = require('../index.js');
const REG = require('../models.json').exchanges;
const M = id => REG[id].model;

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

// Tiers with continuous maintenance deductions (Binance "cum", Bybit "mmDeduction", ...).
function tiers(spec) { // spec: [[cap, lev, mmr], ...]
  const out = []; let floor = 0, cum = 0, prevMmr = 0;
  for (const [cap, lev, mmr] of spec) {
    cum = cum + floor * (mmr - prevMmr);
    out.push([floor, cap, lev, mmr, cum]);
    floor = cap; prevMmr = mmr;
  }
  return out;
}
const one = (mmr, cap = 1e15, lev = 125) => [[0, cap, lev, mmr, 0]];
const BTC = tiers([[300000, 125, 0.004], [800000, 100, 0.005], [3e6, 75, 0.0065], [12e6, 50, 0.01],
  [50e6, 25, 0.02], [80e6, 20, 0.025], [100e6, 10, 0.05], [200e6, 5, 0.1], [300e6, 4, 0.125], [500e6, 2, 0.25]]);

// ---------- official worked examples ----------
t('Bybit help centre: long 1 BTC @40,000, 50x, +3,000 added, MMR 0.5%, taker 0.055% -> 36,380.25', () => {
  const r = C.liquidation({ side: 'long', mode: 'isolated', qty: 1, entry: 40000, leverage: 50, extraMargin: 3000,
    brackets: one(0.005), model: M('bybit') });
  close(Number(r.liq.price.toFixed(2)), 36380.25);
});
t('Gate help centre: long 0.0131 BTC @60,415, margin 79.737, MMR 0.4%, fee 0.075% -> 54,587.4', () => {
  const r = C.liquidationPrice({ side: 'long', qty: 0.0131, entry: 60415, wb: 79.73722738, brackets: one(0.004),
    model: Object.assign({}, M('gate'), { liqFee: 0.00075 }) });
  assert.ok(r.price - 54587.4 >= 0 && r.price - 54587.4 < 0.1, String(r.price)); // Gate truncates to the 0.1 tick
});
t('KuCoin support: long 1 BTC @30,000, 50x, MMR 0.4%, fee 0.06% -> 29,535.9', () => {
  const r = C.liquidation({ side: 'long', mode: 'isolated', qty: 1, entry: 30000, leverage: 50, brackets: one(0.004), model: M('kucoin') });
  close(Number(r.liq.price.toFixed(1)), 29535.9);
});
t('MEXC support: long 10,000 cont x 0.0001 BTC @8,000, 25x, MMR 0.5% -> 7,720', () => {
  const r = C.liquidation({ side: 'long', mode: 'isolated', qty: 1, entry: 8000, leverage: 25, brackets: one(0.005), model: M('mexc') });
  close(r.liq.price, 7720); close(r.maintMargin, 40);
});
t('BingX support: long 10 ETH @1,000, 10x, MMR 0.4% -> 904', () => {
  const r = C.liquidation({ side: 'long', mode: 'isolated', qty: 10, entry: 1000, leverage: 10, brackets: one(0.004), model: M('bingx') });
  close(r.liq.price, 904);
});
t('Hyperliquid docs formula matches the generic solver', () => {
  for (const side of ['long', 'short']) {
    const s = side === 'long' ? 1 : -1, q = 2.5, E = 3000, maxLev = 25, l = 1 / (2 * maxLev), margin = q * E / 10;
    const ref = E - s * (margin - l * q * E) / q / (1 - l * s); // liq_price = price - side*margin_available/size/(1 - l*side)
    const r = C.liquidationPrice({ side, qty: q, entry: E, wb: margin, brackets: one(l), model: M('hyperliquid') });
    close(r.price, ref);
  }
});
t('Bitget help centre formula: (margin + offset - q*E*dir) / (q*(MMR + taker - dir))', () => {
  for (const side of ['long', 'short']) {
    const d = side === 'long' ? 1 : -1;
    const ref = (5000 - 1 * 50000 * d) / (1 * (0.005 + 0.0006 - d));
    close(C.liquidationPrice({ side, qty: 1, entry: 50000, wb: 5000, brackets: one(0.005), model: M('bitget') }).price, ref);
  }
});
t('OKX: equity at liquidation equals maintenance margin plus the liquidation fee', () => {
  const okxTiers = [[0, 50, 125, 0.004, 0], [50, 100, 100, 0.005, 0], [100, 1e9, 50, 0.01, 0]]; // by coins, no deduction
  for (const side of ['long', 'short']) {
    const s = side === 'long' ? 1 : -1, q = 60, E = 60000, wb = q * E / 20;
    const r = C.liquidationPrice({ side, qty: q, entry: E, wb, brackets: okxTiers, model: M('okx') });
    close(wb + s * q * (r.price - E), q * r.price * (0.005 + 0.0005));
    assert.strictEqual(r.bracket[3], 0.005); // 60 coins -> tier 2 whatever the price
  }
});

// ---------- general properties ----------
t('single tier hand-checked (Binance)', () => {
  close(C.liquidationPrice({ side: 'long', qty: 1, entry: 60000, wb: 6000, brackets: one(0.004) }).price, 54000 / 0.996);
  close(C.liquidationPrice({ side: 'short', qty: 1, entry: 60000, wb: 6000, brackets: one(0.004) }).price, 66000 / 1.004);
});
t('1x long with no maintenance is never liquidated', () => {
  assert.ok(C.liquidationPrice({ side: 'long', qty: 1, entry: 100, wb: 100, brackets: one(0) }).none);
});
t('deductions are continuous across tiers', () => {
  for (let i = 1; i < BTC.length; i++) close(C.mmFor(BTC[i - 1], BTC[i][0]), C.mmFor(BTC[i], BTC[i][0]));
});
t('every mark-price model: margin balance equals maintenance (+fee) at liquidation, tier-consistent', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const id of ['binance', 'bybit', 'gate', 'bitget', 'hyperliquid']) {
    const m = M(id);
    for (let k = 0; k < 2000; k++) {
      const side = rnd() < 0.5 ? 'long' : 'short', s = side === 'long' ? 1 : -1;
      const entry = 1000 + rnd() * 100000, notional = 1000 + rnd() * 4e8, qty = notional / entry;
      const b = C.bracketFor(BTC, notional); if (!b) continue;
      const wb = notional / (1 + Math.floor(rnd() * b[2]));
      const r = C.liquidationPrice({ side, qty, entry, wb, brackets: BTC, model: m });
      if (r.none) { assert.ok(s === 1); continue; }
      const nb = C.bracketFor(BTC, qty * r.price) || BTC[BTC.length - 1];
      close(wb + s * qty * (r.price - entry), C.mmFor(nb, qty * r.price) + qty * r.price * m.liqFee, 1e-7);
      assert.ok(s === 1 ? r.price < entry : r.price > entry);
    }
  }
});
t('entry-value models pick the tier at entry (KuCoin, BingX)', () => {
  for (const id of ['kucoin', 'bingx']) {
    const r = C.liquidation({ side: 'long', mode: 'isolated', qty: 5, entry: 62000, leverage: 10, brackets: BTC, model: M(id) });
    assert.strictEqual(r.entryBracket, C.bracketFor(BTC, 5 * 62000));
    assert.strictEqual(r.liq.bracket, r.entryBracket);
  }
});
t('every exchange: higher leverage moves liquidation closer', () => {
  for (const id of Object.keys(REG)) {
    const br = M(id).basis === 'qty' ? [[0, 1e9, 125, 0.004, 0]] : BTC;
    const a = C.liquidation({ side: 'short', mode: 'isolated', qty: 1, entry: 60000, leverage: 5, brackets: br, model: M(id) });
    const b = C.liquidation({ side: 'short', mode: 'isolated', qty: 1, entry: 60000, leverage: 50, brackets: br, model: M(id) });
    assert.ok(b.liq.price < a.liq.price, id);
  }
});
t('leverage above the tier limit is flagged; too-large positions rejected', () => {
  assert.ok(C.liquidation({ side: 'long', mode: 'isolated', qty: 100, entry: 60000, leverage: 100, brackets: BTC })
    .warnings.some(w => w.code === 'leverage' && w.allowed === 50));
  assert.strictEqual(C.liquidation({ side: 'long', mode: 'isolated', qty: 10000, entry: 60000, leverage: 2, brackets: BTC }).error, 'max_position');
  const q = C.liquidation({ side: 'long', mode: 'isolated', qty: 2e9, entry: 1, leverage: 2, brackets: [[0, 1e9, 125, 0.004, 0]], model: M('okx') });
  assert.strictEqual(q.error, 'max_position'); assert.strictEqual(q.basis, 'qty');
});
t('tiers without a max leverage (BingX) do not raise leverage warnings', () => {
  const r = C.liquidation({ side: 'long', mode: 'isolated', qty: 1, entry: 100, leverage: 200, brackets: [[0, 1e9, 0, 0.004, 0]], model: M('bingx') });
  assert.strictEqual(r.warnings.length, 0);
});
t('Bybit added margin is scaled by the taker fee, others are not', () => {
  close(C.isolatedMargin(M('bybit'), 'long', 100, 50), 100 + 50 / (1 - 0.00055));
  close(C.isolatedMargin(M('bybit'), 'short', 100, 50), 100 + 50 / (1 + 0.00055));
  close(C.isolatedMargin(M('binance'), 'long', 100, 50), 150);
  // real Binance position (positionRisk): long 0.001 BTC @ 82709.2, 10x isolated, isolatedWallet 8.2296, liq 74778.74959839
  const real = C.liquidation({ side: 'long', mode: 'isolated', qty: 0.001, entry: 82709.2, leverage: 10, feeOpen: 0.0005,
    brackets: one(0.004), model: M('binance') });
  close(real.marginUsed, 8.2709 - 0.04135, 1e-4);
  assert.ok(Math.abs(real.liq.price - 74778.7496) < 0.5, 'binance real position ' + real.liq.price);
  // cross mode and exchanges without the flag ignore the fee
  close(C.liquidation({ side: 'long', mode: 'isolated', qty: 1, entry: 100, leverage: 10, feeOpen: 0.0005, brackets: one(0.004), model: M('okx') }).marginUsed, 10);
});
t('position size: loss at stop (fees included) equals the risk', () => {
  const r = C.positionSize({ side: 'long', balance: 1000, risk: 20, entry: 60000, stop: 59000, leverage: 10,
    feeOpen: 0.0005, feeClose: 0.0005, step: 0, brackets: BTC });
  close(-C.pnl({ side: 'long', qty: r.qty, entry: 60000, exit: 59000, leverage: 10, feeOpen: 0.0005, feeClose: 0.0005 }).net, 20);
});
t('position size: rounds down to step, warns when liquidation beats the stop', () => {
  close(C.positionSize({ side: 'short', balance: 1000, risk: 20, entry: 60000, stop: 61000, leverage: 10,
    feeOpen: 0.0005, feeClose: 0.0005, step: 0.001, brackets: BTC }).qty, 0.018);
  for (const id of Object.keys(REG)) {
    const br = M(id).basis === 'qty' ? [[0, 1e9, 125, 0.004, 0]] : BTC;
    const r = C.positionSize({ side: 'long', balance: 1000, risk: 20, entry: 60000, stop: 50000, leverage: 20,
      feeOpen: 0.0005, feeClose: 0.0005, step: 0, brackets: br, model: M(id) });
    assert.ok(r.liqBeforeStop, id);
    const ok = C.liquidationPrice({ side: 'long', qty: r.qty, entry: 60000, wb: r.notional / r.safeLeverage, brackets: br, model: M(id) });
    assert.ok(ok.none || ok.price < 50000, id);
  }
});
t('position size: stop on the wrong side is an error', () => {
  assert.strictEqual(C.positionSize({ side: 'long', risk: 10, entry: 100, stop: 105, leverage: 5, feeOpen: 0, feeClose: 0, brackets: BTC }).error, 'stop_side');
});
t('pnl: break-even exit nets zero; ROE on margin', () => {
  for (const side of ['long', 'short']) {
    const be = C.pnl({ side, qty: 3, entry: 2500, exit: 2600, leverage: 10, feeOpen: 0.0005, feeClose: 0.0002 }).breakEven;
    close(C.pnl({ side, qty: 3, entry: 2500, exit: be, leverage: 10, feeOpen: 0.0005, feeClose: 0.0002 }).net, 0, 1e-9);
  }
  close(C.pnl({ side: 'long', qty: 1, entry: 100, exit: 110, leverage: 10, feeOpen: 0, feeClose: 0 }).roe, 1);
});
t('decimals and roundDown', () => {
  assert.strictEqual(C.decimals('0.001'), 3); assert.strictEqual(C.decimals('0.10'), 1);
  assert.strictEqual(C.decimals(1e-7), 7); assert.strictEqual(C.decimals('1'), 0);
  close(C.roundDown(0.0199999, 0.001), 0.019);
});
t('average entry and size for a target average', () => {
  const a = C.averageEntry([{ price: 100, qty: 1 }, { price: 90, qty: 1 }, { price: 0, qty: 5 }, { price: 80, qty: 0 }]);
  close(a.price, 95); close(a.qty, 2); close(a.value, 190);
  assert.strictEqual(C.averageEntry([]), null);
  const x = C.sizeForTargetAverage(1, 100, 80, 90);              // add 1 at 80 -> average 90
  close(x, 1);
  close(C.averageEntry([{ price: 100, qty: 1 }, { price: 80, qty: x }]).price, 90);
  close(C.sizeForTargetAverage(2, 50, 60, 55), 2);               // short side: add above to raise the average
  assert.strictEqual(C.sizeForTargetAverage(1, 100, 80, 75), null); // target beyond the add price is impossible
  assert.strictEqual(C.sizeForTargetAverage(1, 100, 80, 101), null);
  assert.strictEqual(C.sizeForTargetAverage(1, 100, 80, 80), null);
});

t('package helpers: model(), fees(), real Binance position', () => {
  const P = require('../index.js');
  assert.deepStrictEqual(P.model('binance'), REG.binance.model);
  assert.strictEqual(P.fees('okx').taker, REG.okx.fees.taker);
  assert.throws(() => P.model('kraken'), /unknown exchange/);
  const r = P.liquidation({ side: 'long', mode: 'isolated', qty: 0.001, entry: 82709.2, leverage: 10, feeOpen: 0.0005,
    brackets: [[0, 300000, 125, 0.004, 0]], model: P.model('binance') });
  assert.ok(Math.abs(r.liq.price - 74778.7496) < 0.01, String(r.liq.price)); // Binance showed 74778.74959839
});

console.log(`\n${passed} tests passed`);
