"""Data-contract, routing, strategy and report tests. All offline."""

import numpy as np
import pandas as pd
import pytest

from quantdesk import analytics, report, strategies
from quantdesk.backtest.engine import CostModel, run_backtest
from quantdesk.data.base import DataError, normalise, synthetic_history
from quantdesk.data.providers import CoinGeckoProvider, FredProvider, NaverProvider
from quantdesk.data.registry import load_prices, route


# -- data contract ---------------------------------------------------------

def test_normalise_enforces_the_ohlcv_contract():
    frame = synthetic_history("X", days=50)
    assert list(frame.columns) == ["open", "high", "low", "close", "volume"]
    assert frame.index.is_monotonic_increasing
    assert frame.index.tz is None
    assert not frame.index.has_duplicates


def test_normalise_rejects_a_frame_missing_columns():
    bad = pd.DataFrame({"close": [1.0]}, index=pd.to_datetime(["2020-01-01"]))
    with pytest.raises(DataError, match="omitted columns"):
        normalise(bad, "BAD")


def test_normalise_rejects_empty_input():
    with pytest.raises(DataError):
        normalise(pd.DataFrame(), "EMPTY")


def test_normalise_drops_non_positive_closes():
    idx = pd.to_datetime(["2020-01-01", "2020-01-02"])
    frame = pd.DataFrame(
        {"open": [1.0, 1.0], "high": [1.0, 1.0], "low": [1.0, 1.0],
         "close": [10.0, 0.0], "volume": [1.0, 1.0]}, index=idx
    )
    assert len(normalise(frame, "X")) == 1


def test_normalise_deduplicates_sessions():
    idx = pd.to_datetime(["2020-01-01", "2020-01-01"])
    frame = pd.DataFrame(
        {"open": [1.0, 2.0], "high": [1.0, 2.0], "low": [1.0, 2.0],
         "close": [1.0, 2.0], "volume": [1.0, 2.0]}, index=idx
    )
    out = normalise(frame, "X")
    assert len(out) == 1 and out["close"].iloc[0] == 2.0  # keeps the last


def test_synthetic_history_is_deterministic():
    a = synthetic_history("X", days=100, seed=42)
    b = synthetic_history("X", days=100, seed=42)
    pd.testing.assert_frame_equal(a, b)


# -- routing ---------------------------------------------------------------

@pytest.mark.parametrize("ticker,expected", [
    ("005930", "naver"),
    ("005930.KS", "naver"),
    ("KRX:005930", "naver"),
    ("BTC-USD", "coingecko"),
    ("CG:solana", "coingecko"),
    ("FRED:DGS10", "fred"),
    ("SPY", "yahoo"),
    ("QQQ", "yahoo"),
])
def test_tickers_route_to_the_right_provider(ticker, expected):
    assert route(ticker)[0] == expected


def test_ambiguous_tickers_have_a_fallback_chain():
    assert len(route("SPY")) > 1


def test_naver_rejects_a_non_krx_code():
    with pytest.raises(DataError, match="6-digit"):
        NaverProvider.code("SPY")


@pytest.mark.parametrize("symbol,coin,quote", [
    ("BTC-USD", "bitcoin", "usd"),
    ("ETH-KRW", "ethereum", "krw"),
    ("CG:solana/eur", "solana", "eur"),
])
def test_coingecko_symbol_parsing(symbol, coin, quote):
    assert CoinGeckoProvider.parse(symbol) == (coin, quote)


def test_fred_series_id_extraction():
    assert FredProvider.series_id("FRED:DGS10") == "DGS10"


# -- multi-asset loading ---------------------------------------------------

def test_load_prices_aligns_tickers_onto_one_calendar():
    panel = load_prices(["A", "B", "C"], offline=True)
    assert list(panel.columns) == ["A", "B", "C"]
    assert panel.index.is_monotonic_increasing
    assert panel.notna().all().all()


def test_load_prices_needs_at_least_one_ticker():
    with pytest.raises(ValueError):
        load_prices([], offline=True)


# -- strategies ------------------------------------------------------------

@pytest.mark.parametrize("name", sorted(strategies.REGISTRY))
def test_every_strategy_runs_end_to_end(name):
    panel = load_prices(["A", "B", "C", "D"], offline=True)
    result = run_backtest(panel, strategies.build(name),
                          initial_capital=1_000_000.0)
    assert np.isfinite(result.equity).all()
    assert (result.equity > 0).all()
    assert (result.cash >= -1e-6).all()


@pytest.mark.parametrize("name", sorted(strategies.REGISTRY))
def test_no_strategy_ever_levers_above_one(name):
    panel = load_prices(["A", "B", "C"], offline=True)
    result = run_backtest(panel, strategies.build(name))
    assert result.weights.sum(axis=1).max() <= 1.0 + 1e-6


def test_unknown_strategy_name_is_rejected():
    with pytest.raises(KeyError):
        strategies.build("get_rich_quick")


def test_dual_momentum_holds_cash_when_everything_is_falling():
    idx = pd.bdate_range("2020-01-01", periods=400)
    falling = pd.DataFrame(
        {"A": np.linspace(100, 40, 400), "B": np.linspace(100, 50, 400)},
        index=idx,
    )
    weights = strategies.DualMomentum().target_weights(falling)
    assert weights == {}


def test_momentum_skips_the_reversal_month():
    strategy = strategies.CrossSectionalMomentum(top_n=1, lookback=100, skip=20)
    idx = pd.bdate_range("2020-01-01", periods=200)
    # A rose steadily then crashed in the last 20 days; B is the mirror.
    # The skip means the crash is excluded, so A should still be picked.
    a = np.concatenate([np.linspace(100, 200, 180), np.linspace(200, 120, 20)])
    b = np.concatenate([np.linspace(100, 105, 180), np.linspace(105, 150, 20)])
    panel = pd.DataFrame({"A": a, "B": b}, index=idx)
    assert "A" in strategy.target_weights(panel)


def test_sma_strategy_goes_to_cash_below_trend():
    idx = pd.bdate_range("2020-01-01", periods=300)
    falling = pd.DataFrame({"A": np.linspace(200, 100, 300)}, index=idx)
    assert strategies.SmaCrossover(window=200).target_weights(falling) == {}


def test_risk_parity_underweights_the_volatile_asset():
    rng = np.random.default_rng(1)
    idx = pd.bdate_range("2020-01-01", periods=300)
    calm = 100 * np.exp(np.cumsum(rng.normal(0, 0.002, 300)))
    wild = 100 * np.exp(np.cumsum(rng.normal(0, 0.030, 300)))
    panel = pd.DataFrame({"CALM": calm, "WILD": wild}, index=idx)
    weights = strategies.RiskParity(lookback=60).target_weights(panel)
    assert weights["CALM"] > weights["WILD"]


# -- reporting -------------------------------------------------------------

def test_report_renders_self_contained_html():
    panel = load_prices(["A", "B"], offline=True)
    result = run_backtest(panel, strategies.build("buyhold"))
    summary = analytics.summarise(result)
    html = report.render(result, summary, title="Test")

    assert html.startswith("<!doctype html>")
    assert "<svg" in html and "</html>" in html
    # No external resources: the file must open with no network at all.
    assert "http://" not in html and "https://" not in html
    assert "cdn" not in html.lower()


def test_summary_reports_significance_honestly():
    panel = load_prices(["A"], offline=True)
    result = run_backtest(panel, strategies.build("buyhold"))
    summary = analytics.summarise(result)
    assert isinstance(summary.significant, bool)
    assert summary.significant == (abs(summary.t_stat) > 2.0)


def test_compare_table_ranks_by_cagr():
    panel = load_prices(["A", "B", "C"], offline=True)
    summaries = [
        analytics.summarise(run_backtest(panel, strategies.build(n)))
        for n in ("buyhold", "riskparity", "dualmomentum")
    ]
    table = analytics.compare(summaries)
    assert table["CAGR"].is_monotonic_decreasing
