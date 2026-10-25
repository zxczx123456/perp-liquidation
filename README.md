# perp-liquidation

Liquidation price, position size, PnL and average entry for crypto perpetual futures, computed the way **each exchange** computes them: its own formula and the contract's own margin tiers, not one maintenance rate for everything.

Supported: Binance, OKX, Bybit, Gate, Bitget, Hyperliquid, MEXC, KuCoin, BingX (USDT- and USDC-margined linear perpetuals, one-way mode).

Every formula is checked against the exchange's own worked example or a real position (see [Verification](#verification)). The same engine runs the free calculators at **[perptiers.com](https://perptiers.com)**.

```js
const P = require('perp-liquidation');

// Binance BTCUSDT, long 0.001 BTC at 82,709.2, 10x isolated, first tier: 0.4% maintenance, up to 300k USDT
const r = P.liquidation({
  side: 'long', mode: 'isolated', qty: 0.001, entry: 82709.2, leverage: 10,
  feeOpen: 0.0005,                          // Binance takes the opening fee out of isolated margin
  brackets: [[0, 300000, 125, 0.004, 0]],   // [floor, cap, maxLeverage, maintMarginRate, maintAmount]
  model: P.model('binance'),
});
r.liq.price   // 74778.7496 — Binance's own positionRisk showed 74778.74959839
```

## Install

No dependencies, Node 12+ or any browser. Copy `index.js`, `calc.js` and `models.json` into your project, or install straight from this repository with `npm install github:` followed by the repository path.

`calc.js` on its own also works in a `<script>` tag and exposes `window.PerpCalc`.

## Margin tiers ("brackets")

Every function takes the contract's tiers as an array of rows:

```
[floor, cap, maxLeverage, maintMarginRate, maintAmount]
```

`floor`/`cap` are in quote currency (position value) for most exchanges and in **coins** for OKX and MEXC (`model.basis === 'qty'`). `maintAmount` is the deduction that keeps the maintenance margin continuous between tiers (Binance `cum`, Bybit `mmDeduction`); use 0 where the exchange has none.

Where to get them:

| Exchange | Endpoint | Notes |
| --- | --- | --- |
| Binance | `GET /fapi/v1/leverageBracket` | Signed: needs a read-only API key |
| OKX | `GET /api/v5/public/position-tiers?instType=SWAP&tdMode=isolated` | Sizes in contracts: multiply by `ctVal` |
| Bybit | `GET /v5/market/risk-limit?category=linear` | |
| Gate | `GET /api/v4/futures/usdt/risk_limit_tiers` | |
| Bitget | `GET /api/v2/mix/market/query-position-lever` | |
| Hyperliquid | `POST /info {"type":"metaAndAssetCtxs"}` | `marginTables`; maintenance rate = 1 ÷ (2 × max leverage) |
| MEXC | `GET /api/v1/contract/detail` | Risk limit fields per contract |
| KuCoin | `GET /api/v1/contracts/risk-limit/{symbol}` | |
| BingX | `GET /openApi/swap/v1/maintMarginRatio` | Signed; only the first tier's leverage is published |

Already normalised into this format and refreshed every few hours: `https://perptiers.com/data/<exchange>.json` (each symbol's `br` field). Fine for experiments; fetch from the exchange for anything that trades real money.

## How the exchanges differ

Each exchange is a `model` (in `models.json`):

| Exchange | Tier chosen by | Maintenance margin on | Fee in the formula |
| --- | --- | --- | --- |
| Binance | value at the liquidation price | value at liquidation | none (opening fee comes out of isolated margin) |
| OKX | contracts | value at liquidation | 0.05% |
| Bybit | value at the liquidation price | value at liquidation | added margin counts as extra ÷ (1 ∓ taker) |
| Gate | value at the liquidation price | value at liquidation | 0.05% |
| Bitget | value at the liquidation price | value at liquidation | 0.06% |
| Hyperliquid | value at the liquidation price | value at liquidation | none |
| MEXC | contracts | **value at entry** | none |
| KuCoin | **value at entry** | value at liquidation | 0.06% |
| BingX | **value at entry** | **value at entry** | none |

"Tier at the liquidation price" matters for larger positions: a long loses value as price falls, so it can drop into a lower tier before it is liquidated. The solver tries every tier and keeps the price whose value actually falls inside that tier.

The generic formula (Binance-style):

```
liq = (M + maintAmount − s × Q × E) ÷ (Q × (MMR + fee) − s × Q)
```

M = margin behind the position (isolated margin, or wallet balance in cross mode), Q = size in coins, E = entry, s = +1 long / −1 short.

## API

| Function | Returns |
| --- | --- |
| `liquidation({side, mode, qty, entry, leverage, brackets, model, extraMargin?, walletBalance?, feeOpen?})` | `{liq: {price, none, bracket}, notional, initialMargin, marginUsed, maintMargin, entryBracket, distance, warnings}` or `{error: 'max_position'}` |
| `liquidationPrice({side, qty, entry, wb, brackets, model})` | `{price}` or `{none: true}` |
| `positionSize({side, balance, risk, entry, stop, leverage, feeOpen, feeClose, step, minQty, brackets, model})` | size from risk and stop, fees included, plus the highest leverage that keeps liquidation behind the stop |
| `pnl({side, qty, entry, exit, leverage, feeOpen, feeClose})` | gross, fees, net, ROE, break-even exit |
| `averageEntry([{price, qty}, …])` | `{price, qty, value}` |
| `sizeForTargetAverage(qty, average, addPrice, target)` | coins to add at `addPrice` to reach `target`, or `null` |
| `model(exchange)`, `fees(exchange)`, `exchanges` | model and default fee rates per exchange |

Modes: `isolated`, or `cross` with `walletBalance` (single position, one-way mode).

## Verification

`npm test` runs these against the published numbers:

| Source | Case | Result |
| --- | --- | --- |
| Binance, real position (positionRisk) | long 0.001 BTC @82,709.2, 10x isolated | 74,778.75 |
| Bybit help centre | long 1 BTC @40,000, 50x, +3,000 added, MMR 0.5% | 36,380.25 |
| Gate help centre | long 0.0131 BTC @60,415, margin 79.737, MMR 0.4% | 54,587.4 |
| KuCoin support | long 1 BTC @30,000, 50x, MMR 0.4%, fee 0.06% | 29,535.9 |
| MEXC support | long 1 BTC @8,000, 25x, MMR 0.5% | 7,720 |
| BingX support | long 10 ETH @1,000, 10x, MMR 0.4% | 904 |
| Hyperliquid docs | documented formula vs generic solver | match |

Found a contract where the result differs from the exchange? Open an issue with the exchange, contract, side, size, entry, leverage, margin and the exchange's own liquidation price.

## Limits

One-way mode, one position. Cross mode assumes no other open positions. Exchanges change tiers and formulas; `models.json` lists the source each model follows.

## License

MIT. Interactive versions of every function, per exchange and per coin: [perptiers.com](https://perptiers.com).
