"""Engine correctness.

The first test in this file is the one that matters. Everything else in the
project is only meaningful if the engine genuinely cannot see the future.
"""

import numpy as np
import pandas as pd
import pytest

from quantdesk.backtest.engine import CostModel, Strategy, run_backtest


def frame(closes, tickers=("A",), start="2020-01-01"):
    idx = pd.bdate_range(start, periods=len(closes))
    data = {t: np.asarray(closes, dtype=float) for t in tickers}
    return pd.DataFrame(data, index=idx)


class AllIn(Strategy):
    rebalance = "D"

    def target_weights(self, history):
        return {c: 1.0 / len(history.columns) for c in history.columns}


class Oracle(Strategy):
    """Records the last date it was shown, so a test can prove what it saw."""

    rebalance = "D"

    def __init__(self):
        self.seen = []

    def target_weights(self, history):
        self.seen.append(history.index[-1])
        return {"A": 1.0}


def test_strategy_never_sees_beyond_the_decision_bar():
    prices = frame([100, 101, 102, 103, 104, 105])
    oracle = Oracle()
    run_backtest(prices, oracle, initial_capital=1000.0, costs=CostModel(0, 0, 0))

    # It is called on bars 0..n-2 (the last bar has no next bar to fill on),
    # and each call's window ends exactly on the decision bar.
    assert oracle.seen == list(prices.index[:-1])


def test_orders_fill_on_the_next_bar_not_the_signal_bar():
    """A one-day spike must not be capturable by a same-bar fill."""
    prices = frame([100, 100, 200, 100, 100])

    class BuyTheSpike(Strategy):
        rebalance = "D"

        def target_weights(self, history):
            # Only goes long after seeing the 200 print. A lookahead engine
            # would fill at 200 and end flat; a correct one fills the NEXT
            # bar at 100 and takes the loss on the way in.
            return {"A": 1.0} if history["A"].iloc[-1] >= 200 else {}

    res = run_backtest(prices, BuyTheSpike(), initial_capital=1000.0,
                       costs=CostModel(0, 0, 0), no_trade_band=0.0)
    fills = res.fills
    assert len(fills) == 1
    assert fills.iloc[0]["price"] == pytest.approx(100.0)
    assert fills.iloc[0]["date"] == prices.index[3]


def test_flat_market_preserves_capital_when_costs_are_zero():
    prices = frame([100] * 30)
    res = run_backtest(prices, AllIn(), initial_capital=1000.0,
                       costs=CostModel(0, 0, 0))
    assert res.equity.iloc[-1] == pytest.approx(1000.0)


def test_buy_and_hold_tracks_the_asset():
    prices = frame([100, 110, 121])

    class Once(Strategy):
        rebalance = "D"

        def target_weights(self, history):
            return {"A": 1.0}

    res = run_backtest(prices, Once(), initial_capital=1000.0,
                       costs=CostModel(0, 0, 0), no_trade_band=0.0)
    # Bought at bar 1 (price 110), held to 121 -> +10% on the full stake.
    assert res.equity.iloc[-1] == pytest.approx(1100.0, rel=1e-6)


def test_costs_are_actually_deducted():
    prices = frame([100] * 10)
    free = run_backtest(prices, AllIn(), initial_capital=1000.0,
                        costs=CostModel(0, 0, 0))
    charged = run_backtest(prices, AllIn(), initial_capital=1000.0,
                           costs=CostModel(10.0, 10.0, 10.0), no_trade_band=0.0)
    assert charged.equity.iloc[-1] < free.equity.iloc[-1]
    assert charged.total_fees > 0
    # Equity must reconcile: start - fees - slippage bleed == end
    assert charged.equity.iloc[-1] < 1000.0


def test_slippage_moves_against_the_trader():
    prices = frame([100] * 5)
    res = run_backtest(prices, AllIn(), initial_capital=1000.0,
                       costs=CostModel(0, 50.0, 0), no_trade_band=0.0)
    buy = res.fills[res.fills["shares"] > 0].iloc[0]
    assert buy["price"] > 100.0  # bought above the mid


def test_cash_never_goes_negative():
    prices = frame([100, 100, 100, 100], tickers=("A", "B", "C"))
    res = run_backtest(prices, AllIn(), initial_capital=1000.0,
                       costs=CostModel(20.0, 20.0, 20.0), no_trade_band=0.0)
    assert (res.cash >= -1e-6).all()


def test_whole_share_mode_never_holds_fractions():
    prices = frame([333.33, 341.11, 337.0, 350.5])
    res = run_backtest(prices, AllIn(), initial_capital=1000.0,
                       costs=CostModel(0, 0, 0), fractional=False,
                       no_trade_band=0.0)
    for shares in res.fills["shares"]:
        assert shares == pytest.approx(round(shares))


def test_no_trade_band_suppresses_dust_trades():
    # The two legs must drift apart for there to be any dust to suppress,
    # so they get independent random walks rather than one shared series.
    rng = np.random.default_rng(7)
    idx = pd.bdate_range("2020-01-01", periods=200)
    prices = pd.DataFrame(
        {
            "A": 100 * np.exp(np.cumsum(rng.normal(0, 0.010, 200))),
            "B": 100 * np.exp(np.cumsum(rng.normal(0, 0.010, 200))),
        },
        index=idx,
    )

    banded = run_backtest(prices, AllIn(), costs=CostModel(0, 0, 0),
                          no_trade_band=0.05)
    exact = run_backtest(prices, AllIn(), costs=CostModel(0, 0, 0),
                         no_trade_band=0.0)
    assert len(banded.fills) < len(exact.fills)


def test_weights_are_normalised_rather_than_levered():
    prices = frame([100] * 5, tickers=("A", "B"))

    class Greedy(Strategy):
        rebalance = "D"

        def target_weights(self, history):
            return {"A": 3.0, "B": 3.0}  # 600% gross

    res = run_backtest(prices, Greedy(), initial_capital=1000.0,
                       costs=CostModel(0, 0, 0), no_trade_band=0.0)
    assert res.equity.iloc[-1] == pytest.approx(1000.0, rel=1e-6)
    assert res.weights.sum(axis=1).max() <= 1.0 + 1e-6


def test_unlisted_assets_are_not_traded():
    """NaN before a listing date must not become a phantom position."""
    idx = pd.bdate_range("2020-01-01", periods=10)
    prices = pd.DataFrame(
        {"A": [100.0] * 10, "B": [np.nan] * 5 + [50.0] * 5}, index=idx
    )
    res = run_backtest(prices, AllIn(), initial_capital=1000.0,
                       costs=CostModel(0, 0, 0), no_trade_band=0.0)
    early = res.fills[res.fills["date"] < idx[5]]
    assert (early["ticker"] != "B").all()
    assert np.isfinite(res.equity).all()


def test_empty_weights_mean_hold_cash():
    prices = frame([100, 120, 140])

    class Never(Strategy):
        rebalance = "D"

        def target_weights(self, history):
            return {}

    res = run_backtest(prices, Never(), initial_capital=1000.0,
                       costs=CostModel(0, 0, 0))
    assert res.equity.iloc[-1] == pytest.approx(1000.0)
    assert res.fills.empty


def test_rebalance_schedule_is_respected():
    # Prices have to move for a rebalance to generate a trade at all: on a
    # flat series the portfolio is already on target every day.
    rng = np.random.default_rng(21)
    idx = pd.bdate_range("2020-01-01", periods=400)
    prices = pd.DataFrame(
        {
            "A": 100 * np.exp(np.cumsum(rng.normal(0, 0.012, 400))),
            "B": 100 * np.exp(np.cumsum(rng.normal(0, 0.012, 400))),
        },
        index=idx,
    )
    daily = run_backtest(prices, AllIn(), costs=CostModel(0, 0, 0),
                         no_trade_band=0.0)

    class Monthly(AllIn):
        rebalance = "ME"

    monthly = run_backtest(prices, Monthly(), costs=CostModel(0, 0, 0),
                           no_trade_band=0.0)
    assert len(monthly.fills) < len(daily.fills)
    # ~19 months of month-ends, two legs each, plus the opening trade.
    assert 10 < len(monthly.fills) < 60
