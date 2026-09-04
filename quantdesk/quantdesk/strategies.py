"""A small library of strategies that are actually defensible.

Every one of these is a published, widely-replicated rule, not a curve fit.
That is deliberate: a strategy with three tunable parameters and a great
backtest is almost always fitted to the sample, and it is the single most
reliable way to lose money with a "quant system".

All of them consume a history window ending at the decision bar and return
target weights. The engine handles execution, costs, and the one-bar delay.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .backtest.engine import Strategy


class BuyAndHold(Strategy):
    """Fixed weights, rebalanced on the strategy's schedule.

    This is the benchmark every other strategy has to beat *after costs*.
    Most do not. If a clever rule cannot beat equal-weight buy-and-hold on the
    same universe, the clever rule is not worth the fees or the attention.
    """

    def __init__(self, weights: dict[str, float] | None = None,
                 rebalance: str = "YE"):
        self.weights = weights
        self.rebalance = rebalance
        self.name = "Buy & Hold"

    def target_weights(self, history: pd.DataFrame) -> dict[str, float]:
        if self.weights:
            return dict(self.weights)
        cols = [c for c in history.columns if np.isfinite(history[c].iloc[-1])]
        if not cols:
            return {}
        return {c: 1.0 / len(cols) for c in cols}


class SmaCrossover(Strategy):
    """Long while price > its own moving average, otherwise in cash.

    A trend filter. It does not improve raw return in a bull market — it cuts
    drawdown, at the cost of whipsaw losses in choppy sideways markets. Judge
    it on Calmar and max drawdown, not on CAGR.
    """

    def __init__(self, window: int = 200, rebalance: str = "W-FRI"):
        self.window = int(window)
        self.rebalance = rebalance
        self.warmup = self.window
        self.name = f"SMA{self.window} Trend"

    def target_weights(self, history: pd.DataFrame) -> dict[str, float]:
        if len(history) < self.window:
            return {}
        last = history.iloc[-1]
        sma = history.rolling(self.window).mean().iloc[-1]
        holding = [
            c for c in history.columns
            if np.isfinite(last[c]) and np.isfinite(sma[c]) and last[c] > sma[c]
        ]
        if not holding:
            return {}  # everything below trend -> all cash
        # Size against the full universe, so being out of half the names
        # genuinely means half in cash rather than doubling into the rest.
        return {c: 1.0 / len(history.columns) for c in holding}


class CrossSectionalMomentum(Strategy):
    """Hold the top-N assets by 12-month-minus-1-month return.

    Skipping the most recent month is not a detail — short-term reversal
    swamps the momentum effect at the 1-month horizon, and including it is
    what makes naive momentum backtests underperform.
    """

    def __init__(self, top_n: int = 3, lookback: int = 252, skip: int = 21,
                 rebalance: str = "ME"):
        self.top_n = int(top_n)
        self.lookback = int(lookback)
        self.skip = int(skip)
        self.rebalance = rebalance
        self.warmup = self.lookback + self.skip
        self.name = f"Momentum top-{self.top_n}"

    def target_weights(self, history: pd.DataFrame) -> dict[str, float]:
        need = self.lookback + self.skip
        if len(history) < need:
            return {}
        end = history.iloc[-1 - self.skip]
        begin = history.iloc[-need]
        score = (end / begin - 1.0).replace([np.inf, -np.inf], np.nan).dropna()
        # Only positive-momentum names: holding the "best of a bad lot" in a
        # bear market is how momentum strategies take their worst drawdowns.
        score = score[score > 0]
        if score.empty:
            return {}
        picks = score.nlargest(min(self.top_n, len(score))).index
        return {t: 1.0 / self.top_n for t in picks}


class RiskParity(Strategy):
    """Weight inversely to trailing volatility (naive risk parity).

    Equal-weighting a portfolio does not equalise risk: one 40%-vol asset
    dominates four 10%-vol ones. This equalises the risk contribution
    instead, which is usually the single biggest improvement to a
    multi-asset portfolio's Sharpe ratio.
    """

    def __init__(self, lookback: int = 63, rebalance: str = "ME",
                 max_weight: float = 0.60):
        self.lookback = int(lookback)
        self.rebalance = rebalance
        self.max_weight = float(max_weight)
        self.warmup = self.lookback + 1
        self.name = "Risk Parity"

    def target_weights(self, history: pd.DataFrame) -> dict[str, float]:
        if len(history) < self.lookback + 1:
            return {}
        rets = history.pct_change().iloc[-self.lookback:]
        vol = rets.std().replace(0.0, np.nan).dropna()
        if vol.empty:
            return {}
        inv = 1.0 / vol
        weights = (inv / inv.sum()).clip(upper=self.max_weight)
        total = weights.sum()
        return {} if total <= 0 else (weights / total).to_dict()


class DualMomentum(Strategy):
    """Absolute + relative momentum (Antonacci's GEM, simplified).

    Two questions in order: is the best asset beating cash at all (absolute
    momentum)? If not, hold cash. If so, hold the best one (relative
    momentum). The absolute leg is what avoids full participation in a bear
    market, and it is the half most retail implementations drop.
    """

    def __init__(self, lookback: int = 252, rebalance: str = "ME",
                 cash_hurdle: float = 0.0):
        self.lookback = int(lookback)
        self.rebalance = rebalance
        self.cash_hurdle = float(cash_hurdle)
        self.warmup = self.lookback + 1
        self.name = "Dual Momentum"

    def target_weights(self, history: pd.DataFrame) -> dict[str, float]:
        if len(history) < self.lookback + 1:
            return {}
        score = (history.iloc[-1] / history.iloc[-self.lookback - 1] - 1.0)
        score = score.replace([np.inf, -np.inf], np.nan).dropna()
        if score.empty:
            return {}
        best = score.idxmax()
        if score[best] <= self.cash_hurdle:
            return {}  # absolute momentum says: sit in cash
        return {best: 1.0}


class TargetVolatility(Strategy):
    """Scale exposure so realised volatility tracks a target.

    Volatility clusters — calm periods follow calm periods — so scaling down
    after volatility spikes measurably reduces drawdown. Exposure is capped at
    100% because the engine has no margin model.
    """

    def __init__(self, target_vol: float = 0.10, lookback: int = 63,
                 rebalance: str = "W-FRI", base: dict[str, float] | None = None):
        self.target_vol = float(target_vol)
        self.lookback = int(lookback)
        self.rebalance = rebalance
        self.base = base
        self.warmup = self.lookback + 1
        self.name = f"Target Vol {self.target_vol:.0%}"

    def target_weights(self, history: pd.DataFrame) -> dict[str, float]:
        if len(history) < self.lookback + 1:
            return {}
        cols = list(history.columns)
        base = self.base or {c: 1.0 / len(cols) for c in cols}

        rets = history.pct_change().iloc[-self.lookback:]
        port = sum(rets[c] * w for c, w in base.items() if c in rets)
        realised = float(np.std(port, ddof=1)) * np.sqrt(252)
        if not np.isfinite(realised) or realised <= 0:
            return {}
        scale = min(self.target_vol / realised, 1.0)
        return {c: w * scale for c, w in base.items()}


REGISTRY = {
    "buyhold": BuyAndHold,
    "sma": SmaCrossover,
    "momentum": CrossSectionalMomentum,
    "riskparity": RiskParity,
    "dualmomentum": DualMomentum,
    "targetvol": TargetVolatility,
}


def build(name: str, **kwargs) -> Strategy:
    key = name.lower().replace("-", "").replace("_", "")
    if key not in REGISTRY:
        raise KeyError(f"unknown strategy {name!r}; have {sorted(REGISTRY)}")
    return REGISTRY[key](**kwargs)
