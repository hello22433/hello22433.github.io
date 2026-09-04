# quantdesk

Portfolio backtesting, risk analytics and rebalancing — in Python, with no
paid data feed and no broker integration.

It answers three questions:

1. **Would this rule have worked?** — a backtest engine that cannot see the
   future and charges realistic costs.
2. **What did it actually cost me?** — risk statistics that put drawdown,
   turnover and fees next to the return, plus a t-stat that says whether the
   result is distinguishable from luck.
3. **What do I buy on Monday?** — a rebalancer that turns target weights into
   an exact, funded, whole-share order list.

## What this is not

**It does not trade, and it is not advice.** Nothing here connects to a
broker or places an order — the last step is always a human reading a plan and
deciding. No output is a prediction, and a good backtest is not evidence that
a strategy will make money in the future.

If you take one thing from this README, take this: **the most likely outcome
of a strategy with a great backtest is that it was fitted to the sample.**
Everything below is built to make that failure mode visible rather than
hide it.

## Install

```bash
pip install -r requirements.txt   # pandas, numpy — that's all
pip install -e .                  # optional: gives you the `quantdesk` command
```

Python 3.9+. No compiled dependencies, no API key required to start.

## Quick start

```bash
# Trailing returns for a mixed watchlist
python -m quantdesk.cli quote --tickers 005930,SPY,BTC-USD,FRED:DGS10

# Compare strategies on Korean large caps, with the 0.18% sell tax applied
python -m quantdesk.cli compare \
    --tickers 005930,000660,035420,207940,051910 \
    --start 2016-01-01 --market kr --capital 10000000 \
    --benchmark 005930 --html report.html

# Turn today's target weights into orders you can actually place
python -m quantdesk.cli rebalance \
    --tickers 005930,000660,035420,207940,051910 \
    --holdings holdings.json --strategy riskparity \
    --cash 5000000 --market kr --band 0.03

# No network? Deterministic simulated prices exercise every code path.
python -m quantdesk.cli compare --tickers A,B,C --offline
```

`holdings.json` is just `{"005930": 30, "000660": 2}`.

## Data sources

Tickers route to a provider automatically by shape; an explicit
`provider:symbol` prefix always wins. Results are cached on disk
(`~/.quantdesk/cache`, override with `QUANTDESK_CACHE`).

| Ticker form | Provider | Key | Notes |
|---|---|---|---|
| `005930`, `005930.KS` | Naver | no | KOSPI/KOSDAQ, history back to the 1990s |
| `SPY`, `QQQ` | Yahoo → AlphaVantage | no | Yahoo **blocks datacentre IPs**; works from home, falls back in CI |
| `BTC-USD`, `CG:solana` | CoinGecko | no | daily closes only — OHLC collapses to the close |
| `FRED:DGS10`, `FRED:SP500` | FRED | no | macro/index levels; no dividends, no volume |
| `AAPL` (fallback) | AlphaVantage | yes | set `ALPHAVANTAGE_API_KEY`; free tier ≈25 calls/day |

A ticker that fails to load is skipped with a warning rather than killing the
run. Prices are aligned onto the union of trading days and forward-filled, so
a Korean holiday does not silently drop a US session from a mixed portfolio.

## The one guarantee

Most naive backtests compute a signal from today's close and then fill at
today's close. That is a time machine, and it is the single biggest reason
strategies look brilliant on a chart and lose money in an account.

This engine makes that structurally impossible:

```
bar t:    strategy sees history[0..t]  ->  decides target weights
bar t+1:  those orders fill, at bar t+1's price, with slippage and fees
```

`Strategy.target_weights` is handed a *slice* ending at the decision bar, and
the resulting orders are priced off the **next** bar. There is no code path
that reaches forward, so a subclass cannot forget to avoid it. The test
`test_orders_fill_on_the_next_bar_not_the_signal_bar` pins it down with a
one-day price spike that a lookahead engine would capture and this one cannot.

Costs are charged on every fill — commission, slippage (always against you),
and the Korean securities transaction tax on sells. That last one is 18 bps
and it is large enough to change which strategy wins, which is why
`--market kr` is a preset rather than a footnote.

The engine also refuses to lever (weights summing over 1 are normalised, not
borrowed), refuses to spend cash it does not have, and refuses to trade an
asset that had not listed yet.

## Strategies

All of these are published, widely-replicated rules rather than curve fits —
deliberately, because a rule with three tunable parameters and a beautiful
backtest is almost always fitted to its sample.

| Name | Rule |
|---|---|
| `buyhold` | Fixed weights. **The benchmark everything else must beat after costs.** |
| `riskparity` | Weight inversely to trailing volatility — equal risk, not equal money |
| `sma` | Long while price > its own moving average, else cash (trend filter) |
| `momentum` | Top-N by 12-month-minus-1-month return; the skip avoids short-term reversal |
| `dualmomentum` | Relative momentum, gated on beating cash in absolute terms |
| `targetvol` | Scale exposure so realised volatility tracks a target |

Parameters go inline: `--strategy momentum:top_n=2,lookback=252`.

Write your own by subclassing `Strategy` and implementing `target_weights`;
the engine handles execution, costs and the one-bar delay.

```python
from quantdesk import Strategy, load_prices, run_backtest
from quantdesk import analytics

class AboveTheYear(Strategy):
    rebalance = "ME"
    warmup = 252

    def target_weights(self, history):
        last, mean = history.iloc[-1], history.iloc[-252:].mean()
        picks = [c for c in history.columns if last[c] > mean[c]]
        return {c: 1 / len(history.columns) for c in picks}

prices = load_prices(["005930", "000660", "035420"], start="2016-01-01")
result = run_backtest(prices, AboveTheYear())
print(analytics.summarise(result).as_dict())
```

## Reading the output

The comparison table ranks by CAGR but the CLI calls out the best **Calmar**
(return per unit of worst drawdown), because the highest-return line is
usually the one nobody could actually hold. A real 2016–2026 run on Korean
large caps:

```
      Strategy   CAGR    Vol Sharpe   MaxDD Calmar Turnover/yr    Fees t-stat
 Dual Momentum 37.76% 44.93%   0.96 -54.71%   0.69        0.09   1,500   3.08
Momentum top-2 27.43% 34.95%   0.89 -47.15%   0.58        0.22  77,816   2.86
   Risk Parity 21.54% 24.07%   0.95 -33.81%   0.64        0.92 329,312   3.07
    Buy & Hold 20.52% 27.29%   0.84 -38.62%   0.53        0.23  51,587   2.70
```

Dual Momentum "wins" on CAGR — and to earn it you had to sit through a **55%
drawdown**. Risk Parity gets a nearly identical Sharpe with two-thirds of the
pain. That trade-off is the actual decision, and it is invisible if you only
look at the return column.

Note also that Buy & Hold returns 20.5%/yr here. **That is the number to beat,
and three of the five clever strategies do not beat it by enough to justify
their turnover.** Note the fee column: Risk Parity paid 329,312 KRW to add
1 point of CAGR over Buy & Hold.

### The caveats that matter

- **Survivorship / selection bias.** The five tickers above are large caps
  that are still listed and did well. Picking them in 2016 required knowing
  what you know now. Any backtest on a hand-picked universe is partly
  circular, and this one is no exception.
- **t-stat.** `|t| > 2` is the conventional bar for "probably not luck". It is
  a necessary condition, not a sufficient one — and testing six strategies
  means roughly a 1-in-4 chance one clears it by chance alone.
- **A backtest is the best case.** No gaps, no failed orders, no missed
  rebalance because you were busy, and no temptation to override the rule at
  the bottom of that 55% drawdown.

`--html` writes a self-contained report — log-scale equity curve, drawdown
chart, monthly return grid, full statistics table — as one file with zero
external requests. It opens offline and prints cleanly.

## Rebalancing

The part that turns analysis into action. Three details make the difference
between a usable order list and a spreadsheet that loses money at the edges:

- **Whole shares.** KRX has no fractional trading. "Buy 13.7 shares" is not a
  plan; the planner floors to lot size and tells you what it dropped.
- **A no-trade band.** Rebalancing on every 0.3% of drift costs more in fees
  and spread than the drift costs in tracking error. `--band 0.05` suppresses
  those; skipped legs are listed with their reason.
- **Sells before buys.** Orders come out sells-first so proceeds fund the
  buys, and the planner walks the list with a running cash balance, trimming
  any buy that would bounce.

## Development

```bash
python -m pytest -q     # 77 tests, no network required
```

The suite runs entirely on deterministic simulated data. The tests worth
reading first are in `tests/test_engine.py`: they prove the strategy never
sees past its decision bar, that fills land on the next bar, that costs are
deducted, that slippage moves against you, and that cash never goes negative.

Analytics are checked against hand-computable cases — a series that doubles in
exactly two years must give `2**(1/2)-1`, a 120→60 path must give a 50%
drawdown, and beta against itself must be exactly 1.

## Licence

MIT. Research tooling — use it to think, not to autopilot.
