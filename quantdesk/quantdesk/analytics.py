"""Performance and risk statistics.

Two opinions are baked in here:

1. **CAGR without drawdown is marketing.** Every summary reports the pain
   alongside the gain, because a 20%/yr strategy with a 60% drawdown is one
   most people will abandon at the bottom and never actually earn.
2. **Sharpe on daily data is noisy.** A Sharpe computed over 18 months has a
   standard error near 0.6 — so ``summary`` reports the sample length and
   ``t_stat`` next to it, and ``significant`` says plainly whether the result
   is distinguishable from luck.
"""

from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd

TRADING_DAYS = 252


#: Below this, a standard deviation is floating-point noise rather than risk.
#: Comparing to exact zero is not enough: 200 copies of 0.001 have a computed
#: std around 1e-19, which would turn a risk-free series into a Sharpe of 1e16.
_ZERO_VOL = 1e-12


def _clean(returns: pd.Series) -> pd.Series:
    return pd.Series(returns).replace([np.inf, -np.inf], np.nan).dropna()


def cagr(equity: pd.Series) -> float:
    """Compound annual growth rate from the equity curve."""
    equity = equity.dropna()
    if len(equity) < 2 or equity.iloc[0] <= 0:
        return float("nan")
    years = (equity.index[-1] - equity.index[0]).days / 365.25
    if years <= 0:
        return float("nan")
    return float((equity.iloc[-1] / equity.iloc[0]) ** (1 / years) - 1)


def annual_volatility(returns: pd.Series) -> float:
    r = _clean(returns)
    return float(r.std(ddof=1) * np.sqrt(TRADING_DAYS)) if len(r) > 1 else float("nan")


def sharpe(returns: pd.Series, risk_free: float = 0.0) -> float:
    """Annualised Sharpe ratio. ``risk_free`` is an annual rate."""
    r = _clean(returns) - risk_free / TRADING_DAYS
    if len(r) < 2:
        return float("nan")
    sd = r.std(ddof=1)
    if not np.isfinite(sd) or sd < _ZERO_VOL:
        return float("nan")
    return float(r.mean() / sd * np.sqrt(TRADING_DAYS))


def sortino(returns: pd.Series, risk_free: float = 0.0) -> float:
    """Like Sharpe but penalising only downside deviation."""
    r = _clean(returns) - risk_free / TRADING_DAYS
    downside = r[r < 0]
    if len(r) < 2 or downside.empty:
        return float("nan")
    dd = np.sqrt((downside ** 2).mean())
    if not np.isfinite(dd) or dd < _ZERO_VOL:
        return float("nan")
    return float(r.mean() / dd * np.sqrt(TRADING_DAYS))


def drawdown_series(equity: pd.Series) -> pd.Series:
    equity = equity.dropna()
    return equity / equity.cummax() - 1.0


def max_drawdown(equity: pd.Series) -> float:
    dd = drawdown_series(equity)
    return float(dd.min()) if not dd.empty else float("nan")


def drawdown_detail(equity: pd.Series) -> dict:
    """Worst drawdown with its peak, trough, recovery date and durations."""
    dd = drawdown_series(equity)
    if dd.empty:
        return {}
    trough = dd.idxmin()
    peak = equity.loc[:trough].idxmax()
    after = equity.loc[trough:]
    recovered = after[after >= equity.loc[peak]]
    recovery = recovered.index[0] if len(recovered) else None
    return {
        "depth": float(dd.min()),
        "peak": peak,
        "trough": trough,
        "recovery": recovery,
        "drawdown_days": int((trough - peak).days),
        "recovery_days": int((recovery - trough).days) if recovery is not None else None,
        "underwater_days": int(((recovery or equity.index[-1]) - peak).days),
    }


def calmar(equity: pd.Series) -> float:
    """CAGR divided by max drawdown — return per unit of worst-case pain."""
    mdd = max_drawdown(equity)
    if not np.isfinite(mdd) or mdd == 0:
        return float("nan")
    return float(cagr(equity) / abs(mdd))


def value_at_risk(returns: pd.Series, level: float = 0.95) -> float:
    r = _clean(returns)
    return float(np.percentile(r, (1 - level) * 100)) if len(r) else float("nan")


def conditional_var(returns: pd.Series, level: float = 0.95) -> float:
    """Average loss on the days worse than VaR — the tail that VaR hides."""
    r = _clean(returns)
    if r.empty:
        return float("nan")
    cutoff = np.percentile(r, (1 - level) * 100)
    tail = r[r <= cutoff]
    return float(tail.mean()) if len(tail) else float("nan")


def alpha_beta(returns: pd.Series, benchmark: pd.Series) -> tuple[float, float]:
    """Annualised alpha and beta from an OLS fit against ``benchmark``."""
    joined = pd.concat([_clean(returns), _clean(benchmark)], axis=1,
                       join="inner").dropna()
    if len(joined) < 3:
        return float("nan"), float("nan")
    y, x = joined.iloc[:, 0].to_numpy(), joined.iloc[:, 1].to_numpy()
    var = x.var(ddof=1)
    if not np.isfinite(var) or var < _ZERO_VOL:
        return float("nan"), float("nan")
    beta = float(np.cov(y, x, ddof=1)[0, 1] / var)
    alpha = float((y.mean() - beta * x.mean()) * TRADING_DAYS)
    return alpha, beta


def t_statistic(returns: pd.Series) -> float:
    """t-stat of the mean daily return: is this edge distinguishable from 0?"""
    r = _clean(returns)
    if len(r) < 3:
        return float("nan")
    sd = r.std(ddof=1)
    if not np.isfinite(sd) or sd < _ZERO_VOL:
        return float("nan")
    return float(r.mean() / (sd / np.sqrt(len(r))))


def monthly_returns(equity: pd.Series) -> pd.Series:
    return equity.resample("ME").last().pct_change().dropna()


def monthly_table(equity: pd.Series) -> pd.DataFrame:
    """Years as rows, months as columns — where losing streaks become visible."""
    m = monthly_returns(equity)
    if m.empty:
        return pd.DataFrame()
    table = pd.DataFrame(
        {"year": m.index.year, "month": m.index.month, "ret": m.values}
    ).pivot(index="year", columns="month", values="ret")
    return table.reindex(columns=range(1, 13))


@dataclasses.dataclass
class Summary:
    name: str
    start: pd.Timestamp
    end: pd.Timestamp
    years: float
    initial: float
    final: float
    total_return: float
    cagr: float
    volatility: float
    sharpe: float
    sortino: float
    max_drawdown: float
    calmar: float
    var95: float
    cvar95: float
    best_day: float
    worst_day: float
    win_rate: float
    t_stat: float
    fees_paid: float
    fee_drag_annual: float
    avg_turnover_annual: float
    exposure: float
    alpha: float = float("nan")
    beta: float = float("nan")

    @property
    def significant(self) -> bool:
        """|t| > 2 — the conventional bar for "probably not just luck"."""
        return bool(np.isfinite(self.t_stat) and abs(self.t_stat) > 2.0)

    def as_dict(self) -> dict:
        d = dataclasses.asdict(self)
        d["significant"] = self.significant
        return d


def summarise(result, benchmark_returns: pd.Series | None = None,
              risk_free: float = 0.0) -> Summary:
    """Build the full statistics block for a :class:`BacktestResult`."""
    equity, rets = result.equity.dropna(), result.returns
    years = max((equity.index[-1] - equity.index[0]).days / 365.25, 1e-9)
    invested = result.weights.sum(axis=1) if not result.weights.empty else pd.Series(dtype=float)

    fees = float(result.costs.sum())
    turnover = result.turnover

    summary = Summary(
        name=result.strategy_name,
        start=equity.index[0],
        end=equity.index[-1],
        years=float(years),
        initial=float(result.initial_capital),
        final=float(equity.iloc[-1]),
        total_return=float(equity.iloc[-1] / equity.iloc[0] - 1),
        cagr=cagr(equity),
        volatility=annual_volatility(rets),
        sharpe=sharpe(rets, risk_free),
        sortino=sortino(rets, risk_free),
        max_drawdown=max_drawdown(equity),
        calmar=calmar(equity),
        var95=value_at_risk(rets),
        cvar95=conditional_var(rets),
        best_day=float(rets.max()) if len(rets) else float("nan"),
        worst_day=float(rets.min()) if len(rets) else float("nan"),
        win_rate=float((rets[rets != 0] > 0).mean()) if (rets != 0).any() else float("nan"),
        t_stat=t_statistic(rets),
        fees_paid=fees,
        # Fees as an annualised drag on the average capital base — the number
        # that says whether trading frequency is quietly eating the edge.
        fee_drag_annual=float(fees / equity.mean() / years) if equity.mean() else float("nan"),
        avg_turnover_annual=float(turnover.sum() / years),
        exposure=float(invested.mean()) if len(invested) else float("nan"),
    )

    if benchmark_returns is not None and len(benchmark_returns):
        summary.alpha, summary.beta = alpha_beta(rets, benchmark_returns)
    return summary


def compare(summaries: list[Summary]) -> pd.DataFrame:
    """Side-by-side table, best CAGR first."""
    rows = []
    for s in summaries:
        rows.append(
            {
                "Strategy": s.name,
                "CAGR": s.cagr,
                "Vol": s.volatility,
                "Sharpe": s.sharpe,
                "Sortino": s.sortino,
                "MaxDD": s.max_drawdown,
                "Calmar": s.calmar,
                "Turnover/yr": s.avg_turnover_annual,
                "Fees": s.fees_paid,
                "t-stat": s.t_stat,
                "Final": s.final,
            }
        )
    return pd.DataFrame(rows).sort_values("CAGR", ascending=False).reset_index(drop=True)
