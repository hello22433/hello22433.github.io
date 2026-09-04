"""Analytics checked against hand-computable cases, and rebalancer invariants."""

import numpy as np
import pandas as pd
import pytest

from quantdesk import analytics
from quantdesk.rebalance import build_plan


def equity(values, start="2020-01-01"):
    return pd.Series(values, index=pd.bdate_range(start, periods=len(values)),
                     dtype=float)


# -- analytics -------------------------------------------------------------

def test_cagr_matches_hand_calculation():
    # Exactly 2 years (calendar), doubling: 2 ** (1/2) - 1 = 41.42%
    idx = pd.DatetimeIndex(["2020-01-01", "2022-01-01"])
    curve = pd.Series([100.0, 200.0], index=idx)
    years = (idx[-1] - idx[0]).days / 365.25
    assert analytics.cagr(curve) == pytest.approx(2 ** (1 / years) - 1)


def test_max_drawdown_is_peak_to_trough():
    curve = equity([100, 120, 60, 90, 130])
    assert analytics.max_drawdown(curve) == pytest.approx(-0.5)  # 120 -> 60


def test_drawdown_detail_finds_peak_trough_and_recovery():
    curve = equity([100, 120, 60, 90, 130])
    detail = analytics.drawdown_detail(curve)
    assert detail["depth"] == pytest.approx(-0.5)
    assert detail["peak"] == curve.index[1]
    assert detail["trough"] == curve.index[2]
    assert detail["recovery"] == curve.index[4]


def test_unrecovered_drawdown_reports_no_recovery():
    curve = equity([100, 150, 80, 90])
    assert analytics.drawdown_detail(curve)["recovery"] is None


def test_sharpe_of_constant_returns_is_undefined_not_infinite():
    rets = pd.Series([0.001] * 100, index=pd.bdate_range("2020-01-01", periods=100))
    assert np.isnan(analytics.sharpe(rets))


def test_sharpe_scales_with_annualisation():
    rng = np.random.default_rng(3)
    rets = pd.Series(rng.normal(0.0005, 0.01, 2000),
                     index=pd.bdate_range("2015-01-01", periods=2000))
    expected = rets.mean() / rets.std(ddof=1) * np.sqrt(252)
    assert analytics.sharpe(rets) == pytest.approx(expected)


def test_sortino_ignores_upside_volatility():
    """Adding a huge up-day must not worsen Sortino the way it worsens Sharpe."""
    base = [0.01, -0.01] * 60
    calm = pd.Series(base, index=pd.bdate_range("2020-01-01", periods=120))
    spiked = calm.copy()
    spiked.iloc[10] = 0.30
    assert analytics.sortino(spiked) > analytics.sortino(calm)


def test_beta_of_an_asset_against_itself_is_one():
    rng = np.random.default_rng(11)
    rets = pd.Series(rng.normal(0, 0.01, 500),
                     index=pd.bdate_range("2020-01-01", periods=500))
    alpha, beta = analytics.alpha_beta(rets, rets)
    assert beta == pytest.approx(1.0)
    assert alpha == pytest.approx(0.0, abs=1e-9)


def test_beta_of_a_doubled_series_is_two():
    rng = np.random.default_rng(12)
    bench = pd.Series(rng.normal(0, 0.01, 500),
                      index=pd.bdate_range("2020-01-01", periods=500))
    _, beta = analytics.alpha_beta(bench * 2, bench)
    assert beta == pytest.approx(2.0)


def test_cvar_is_never_better_than_var():
    rng = np.random.default_rng(5)
    rets = pd.Series(rng.normal(0, 0.02, 1000),
                     index=pd.bdate_range("2018-01-01", periods=1000))
    assert analytics.conditional_var(rets) <= analytics.value_at_risk(rets)


def test_calmar_is_cagr_over_max_drawdown():
    curve = equity(list(np.linspace(100, 200, 300)) + [150])
    expected = analytics.cagr(curve) / abs(analytics.max_drawdown(curve))
    assert analytics.calmar(curve) == pytest.approx(expected)


def test_metrics_survive_a_flat_or_degenerate_curve():
    curve = equity([100] * 50)
    assert analytics.max_drawdown(curve) == pytest.approx(0.0)
    assert np.isnan(analytics.calmar(curve))


# -- rebalancer ------------------------------------------------------------

def test_plan_moves_holdings_toward_target():
    plan = build_plan(
        holdings={"A": 100, "B": 0},
        prices={"A": 100.0, "B": 50.0},
        targets={"A": 0.5, "B": 0.5},
        cash=0.0, band=0.0, commission_bps=0, slippage_bps=0,
    )
    sides = {o.ticker: o.side for o in plan.orders}
    assert sides["A"] == "SELL" and sides["B"] == "BUY"


def test_sells_are_ordered_before_buys():
    plan = build_plan(
        holdings={"A": 100},
        prices={"A": 100.0, "B": 100.0},
        targets={"B": 1.0},
        band=0.0, commission_bps=0, slippage_bps=0,
    )
    sides = [o.side for o in plan.orders]
    assert sides == sorted(sides, key=lambda s: s != "SELL")


def test_no_trade_band_suppresses_small_drift():
    plan = build_plan(
        holdings={"A": 51, "B": 49},
        prices={"A": 100.0, "B": 100.0},
        targets={"A": 0.5, "B": 0.5},
        band=0.05,
    )
    assert plan.orders == []
    assert plan.skipped


def test_whole_share_orders_only():
    plan = build_plan(
        holdings={},
        prices={"A": 333.33},
        targets={"A": 1.0},
        cash=1000.0, band=0.0, fractional=False,
    )
    assert all(float(o.shares).is_integer() for o in plan.orders)


def test_lot_size_is_respected():
    plan = build_plan(
        holdings={}, prices={"A": 10.0}, targets={"A": 1.0},
        cash=1000.0, band=0.0, lot_size=10, fractional=False,
    )
    assert all(o.shares % 10 == 0 for o in plan.orders)


def test_buys_never_exceed_available_cash():
    plan = build_plan(
        holdings={}, prices={"A": 100.0, "B": 100.0},
        targets={"A": 0.5, "B": 0.5},
        cash=1000.0, band=0.0, commission_bps=50.0, slippage_bps=50.0,
    )
    spent = sum(o.notional for o in plan.orders if o.side == "BUY")
    assert spent <= 1000.0
    assert plan.cash_after >= -1e-6


def test_over_allocated_targets_are_rejected():
    with pytest.raises(ValueError, match="margin"):
        build_plan(holdings={}, prices={"A": 10.0}, targets={"A": 1.5}, cash=100.0)


def test_missing_price_is_an_error_not_a_silent_skip():
    with pytest.raises(ValueError, match="no price"):
        build_plan(holdings={"A": 1}, prices={}, targets={"A": 1.0})


def test_dropped_ticker_is_fully_liquidated():
    plan = build_plan(
        holdings={"OLD": 10}, prices={"OLD": 100.0, "NEW": 100.0},
        targets={"NEW": 1.0}, band=0.0, commission_bps=0, slippage_bps=0,
    )
    sells = [o for o in plan.orders if o.ticker == "OLD"]
    assert sells and sells[0].shares == 10


def test_cash_buffer_leaves_headroom():
    plan = build_plan(
        holdings={}, prices={"A": 1.0}, targets={"A": 1.0},
        cash=10_000.0, band=0.0, commission_bps=0, slippage_bps=0,
        cash_buffer=0.01,
    )
    assert plan.cash_after >= 10_000.0 * 0.009
