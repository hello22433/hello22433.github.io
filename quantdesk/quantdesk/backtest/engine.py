"""Event-driven backtest engine.

The whole point of this module is one guarantee:

    **A decision made on bar ``t`` can only ever use data up to and including
    bar ``t``, and it fills on bar ``t+1``.**

That is the difference between a backtest and a fantasy. Most naive vectorised
backtests compute a signal from today's close and then fill at today's close —
which is a time machine, and it is why so many strategies look brilliant on a
chart and lose money in an account.

The engine enforces it structurally: :meth:`Strategy.target_weights` is handed
a *slice* of history ending at the decision bar, and the resulting orders are
priced off the **next** bar. There is no code path that can see the future,
so it cannot be forgotten in a subclass.

Costs are charged on every fill: commission, spread/slippage, and (for Korean
sells) transaction tax. Ignoring these is the second-most-common way a
backtest lies — a daily-rebalanced strategy can look like +15%/yr gross and
be flat after costs.
"""

from __future__ import annotations

import dataclasses
import math
from typing import Iterable

import numpy as np
import pandas as pd

CASH = "CASH"


@dataclasses.dataclass(frozen=True)
class CostModel:
    """Per-fill trading frictions, all in basis points of notional.

    commission_bps
        Broker fee each way. Korean retail is ~1.5 bps online; US brokers are
        often 0.
    slippage_bps
        Half-spread plus market impact. 5 bps is a fair default for a liquid
        large-cap or ETF; illiquid names are far worse.
    sell_tax_bps
        Charged on sells only. KRX securities transaction tax is ~18 bps
        (0.18%) — set to 0 for US equities.
    """

    commission_bps: float = 1.5
    slippage_bps: float = 5.0
    sell_tax_bps: float = 0.0

    def fill_price(self, price: float, side: int) -> float:
        """Slippage always moves against you: buys fill up, sells fill down."""
        return price * (1.0 + side * self.slippage_bps / 1e4)

    def fee(self, notional: float, side: int) -> float:
        bps = self.commission_bps + (self.sell_tax_bps if side < 0 else 0.0)
        return abs(notional) * bps / 1e4


@dataclasses.dataclass
class Fill:
    date: pd.Timestamp
    ticker: str
    shares: float          # signed: + buy, - sell
    price: float           # after slippage
    fee: float
    notional: float        # signed cash impact before fee


class Strategy:
    """Base strategy: map a history window to target portfolio weights.

    Subclasses implement :meth:`target_weights`. Returning ``{}`` means "hold
    whatever you already have"; returning weights that sum to less than 1
    leaves the remainder in cash. Weights are clipped to be non-negative
    unless ``allow_short`` is set on the subclass — this engine's accounting
    assumes long-only by default.
    """

    name: str = "strategy"
    allow_short: bool = False
    #: how often to re-evaluate: 'D', 'W-FRI', 'ME', 'QE' (pandas offset alias)
    rebalance: str = "ME"
    #: bars of history required before the strategy will trade
    warmup: int = 0

    def target_weights(self, history: pd.DataFrame) -> dict[str, float]:
        raise NotImplementedError

    def __str__(self) -> str:
        return self.name


@dataclasses.dataclass
class BacktestResult:
    equity: pd.Series                 # total portfolio value per bar
    returns: pd.Series                # simple daily returns of equity
    weights: pd.DataFrame             # end-of-bar actual weights per asset
    fills: pd.DataFrame
    cash: pd.Series
    costs: pd.Series                  # fees paid per bar
    strategy_name: str
    initial_capital: float
    prices: pd.DataFrame

    @property
    def total_fees(self) -> float:
        return float(self.costs.sum())

    @property
    def turnover(self) -> pd.Series:
        """One-way turnover per bar as a fraction of portfolio value."""
        if self.fills.empty:
            return pd.Series(0.0, index=self.equity.index)
        traded = (
            self.fills.assign(gross=self.fills["notional"].abs())
            .groupby("date")["gross"].sum()
            .reindex(self.equity.index, fill_value=0.0)
        )
        return (traded / self.equity.shift(1).bfill()).fillna(0.0)


def _rebalance_dates(index: pd.DatetimeIndex, rule: str) -> set[pd.Timestamp]:
    """The last available trading day within each period of ``rule``.

    Using the last *available* bar rather than the calendar date matters:
    a month-end that lands on a weekend or a holiday must still produce
    exactly one rebalance, on the last session that actually traded.
    """
    if rule.upper() in ("D", "DAILY"):
        return set(index)
    marks = pd.Series(index, index=index).resample(rule).last().dropna()
    return set(pd.DatetimeIndex(marks.values))


def run_backtest(
    prices: pd.DataFrame,
    strategy: Strategy,
    *,
    initial_capital: float = 10_000_000.0,
    costs: CostModel | None = None,
    fractional: bool = True,
    lot_size: int = 1,
    no_trade_band: float = 0.005,
) -> BacktestResult:
    """Run ``strategy`` over ``prices`` (index=dates, columns=tickers).

    Parameters
    ----------
    fractional
        Whole shares only when False — which is the honest setting for KRX and
        for most non-fractional brokers, and it matters for small accounts.
    no_trade_band
        Skip any rebalance leg smaller than this fraction of portfolio value.
        Without a band, floating-point drift generates a constant dribble of
        tiny, fee-heavy trades that a real person would never place.
    """
    if prices.empty:
        raise ValueError("no price data to backtest")

    prices = prices.sort_index()
    costs = costs or CostModel()
    tickers = list(prices.columns)
    dates = prices.index

    rebal_days = _rebalance_dates(dates, strategy.rebalance)

    shares = {t: 0.0 for t in tickers}
    cash = float(initial_capital)
    pending: dict[str, float] | None = None   # weights decided on the prior bar

    equity_out, cash_out, cost_out = [], [], []
    weight_rows, fills = [], []

    for i, date in enumerate(dates):
        row = prices.iloc[i]
        fee_today = 0.0

        # ---- 1. Execute what the previous bar decided, at TODAY's price.
        # This ordering is the no-lookahead guarantee: `pending` was computed
        # from data that ended at bar i-1 and cannot contain anything from
        # bar i.
        if pending is not None:
            marked = cash + sum(
                shares[t] * row[t] for t in tickers if np.isfinite(row[t])
            )
            for ticker, target_w in pending.items():
                price = row.get(ticker, np.nan)
                if not np.isfinite(price) or price <= 0:
                    continue  # not yet listed / no print today: cannot trade it

                target_value = marked * target_w
                current_value = shares[ticker] * price
                delta_value = target_value - current_value
                if abs(delta_value) < no_trade_band * marked:
                    continue

                side = 1 if delta_value > 0 else -1
                fill_px = costs.fill_price(price, side)
                delta_shares = delta_value / fill_px
                if not fractional:
                    step = max(lot_size, 1)
                    delta_shares = math.floor(abs(delta_shares) / step) * step * side
                if delta_shares == 0:
                    continue

                # Never sell more than held (long-only) and never spend cash
                # that is not there — a backtest that quietly goes negative is
                # reporting leverage nobody authorised.
                if delta_shares < 0:
                    delta_shares = -min(-delta_shares, shares[ticker])
                    if delta_shares == 0:
                        continue

                notional = delta_shares * fill_px
                fee = costs.fee(notional, side)
                if delta_shares > 0 and notional + fee > cash:
                    affordable = max(cash - fee, 0.0) / fill_px
                    if not fractional:
                        step = max(lot_size, 1)
                        affordable = math.floor(affordable / step) * step
                    if affordable <= 0:
                        continue
                    delta_shares = affordable
                    notional = delta_shares * fill_px
                    fee = costs.fee(notional, side)

                shares[ticker] += delta_shares
                cash -= notional + fee
                fee_today += fee
                fills.append(
                    Fill(date, ticker, delta_shares, fill_px, fee, notional)
                )
            pending = None

        # ---- 2. Mark the book at today's close.
        holdings_value = sum(
            shares[t] * row[t] for t in tickers if np.isfinite(row[t])
        )
        equity = cash + holdings_value
        equity_out.append(equity)
        cash_out.append(cash)
        cost_out.append(fee_today)
        weight_rows.append(
            {
                t: (shares[t] * row[t] / equity if equity > 0 and np.isfinite(row[t])
                    else 0.0)
                for t in tickers
            }
        )

        # ---- 3. Decide, using history that ends at TODAY, fill NEXT bar.
        if date in rebal_days and i + 1 < len(dates) and i + 1 >= strategy.warmup:
            window = prices.iloc[: i + 1]
            proposed = strategy.target_weights(window) or {}
            pending = _sanitise(proposed, tickers, strategy.allow_short) or None

    index = dates
    equity_s = pd.Series(equity_out, index=index, name="equity")
    fills_df = pd.DataFrame([dataclasses.asdict(f) for f in fills])
    if fills_df.empty:
        fills_df = pd.DataFrame(
            columns=["date", "ticker", "shares", "price", "fee", "notional"]
        )

    return BacktestResult(
        equity=equity_s,
        returns=equity_s.pct_change().fillna(0.0),
        weights=pd.DataFrame(weight_rows, index=index),
        fills=fills_df,
        cash=pd.Series(cash_out, index=index, name="cash"),
        costs=pd.Series(cost_out, index=index, name="costs"),
        strategy_name=str(strategy),
        initial_capital=float(initial_capital),
        prices=prices,
    )


def _sanitise(weights: dict, tickers: Iterable[str],
              allow_short: bool) -> dict[str, float]:
    """Drop unknown tickers, clip shorts, and scale down if over-invested."""
    known = set(tickers)
    clean = {
        t: float(w)
        for t, w in weights.items()
        if t in known and np.isfinite(w) and (allow_short or w > 0)
    }
    gross = sum(abs(w) for w in clean.values())
    if gross > 1.0:
        # Normalise instead of silently levering up: this engine has no
        # margin model, so >100% invested would be free money.
        clean = {t: w / gross for t, w in clean.items()}
    return clean
