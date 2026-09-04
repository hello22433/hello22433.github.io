"""Command-line interface.

    quantdesk backtest  --tickers SPY,QQQ,GLD --strategy riskparity
    quantdesk compare   --tickers 005930,000660,035420 --market kr
    quantdesk rebalance --holdings holdings.json --targets targets.json
    quantdesk quote     --tickers SPY,BTC-USD,FRED:DGS10
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from . import analytics, report, strategies
from .backtest.engine import CostModel, run_backtest
from .data.registry import load_prices
from .rebalance import build_plan, targets_from_strategy

# Cost presets. Korean retail pays a securities transaction tax on every sell
# that US investors do not, and it is large enough (18 bps) to change which
# strategy wins — so it is a first-class setting, not a footnote.
MARKETS = {
    "kr": dict(commission_bps=1.5, slippage_bps=8.0, sell_tax_bps=18.0,
               currency="KRW", fractional=False, capital=10_000_000.0),
    "us": dict(commission_bps=0.0, slippage_bps=5.0, sell_tax_bps=0.0,
               currency="USD", fractional=True, capital=10_000.0),
    "crypto": dict(commission_bps=10.0, slippage_bps=15.0, sell_tax_bps=0.0,
                   currency="USD", fractional=True, capital=10_000.0),
}


def _tickers(raw: str) -> list[str]:
    return [t.strip() for t in raw.split(",") if t.strip()]


def _load(args) -> pd.DataFrame:
    prices = load_prices(
        _tickers(args.tickers), args.start, args.end,
        offline=args.offline, use_cache=not args.no_cache,
    )
    for problem in prices.attrs.get("problems", []):
        print(f"  ! {problem}", file=sys.stderr)
    if prices.empty:
        raise SystemExit("no usable price data")
    print(f"  loaded {len(prices.columns)} tickers, {len(prices)} sessions "
          f"({prices.index[0]:%Y-%m-%d} → {prices.index[-1]:%Y-%m-%d})",
          file=sys.stderr)
    return prices


def _costs(args) -> tuple[CostModel, dict]:
    preset = dict(MARKETS[args.market])
    if args.commission_bps is not None:
        preset["commission_bps"] = args.commission_bps
    if args.slippage_bps is not None:
        preset["slippage_bps"] = args.slippage_bps
    if args.sell_tax_bps is not None:
        preset["sell_tax_bps"] = args.sell_tax_bps
    model = CostModel(
        commission_bps=preset["commission_bps"],
        slippage_bps=preset["slippage_bps"],
        sell_tax_bps=preset["sell_tax_bps"],
    )
    return model, preset


def _strategy(spec: str):
    """Parse ``name`` or ``name:key=value,key=value``."""
    name, _, tail = spec.partition(":")
    kwargs = {}
    for part in filter(None, tail.split(",")):
        key, _, value = part.partition("=")
        try:
            kwargs[key.strip()] = int(value)
        except ValueError:
            try:
                kwargs[key.strip()] = float(value)
            except ValueError:
                kwargs[key.strip()] = value.strip()
    return strategies.build(name.strip(), **kwargs)


def _run_all(prices, specs, args):
    model, preset = _costs(args)
    capital = args.capital if args.capital is not None else preset["capital"]

    bench_returns = None
    if args.benchmark:
        if args.benchmark in prices.columns:
            bench_returns = prices[args.benchmark].pct_change().fillna(0.0)
        else:
            print(f"  ! benchmark {args.benchmark} not in universe; skipping alpha/beta",
                  file=sys.stderr)

    results, summaries = [], []
    for spec in specs:
        strategy = _strategy(spec)
        result = run_backtest(
            prices, strategy, initial_capital=capital, costs=model,
            fractional=preset["fractional"],
        )
        results.append(result)
        summaries.append(analytics.summarise(result, bench_returns))
    return results, summaries, preset


def _emit(results, summaries, preset, args, title):
    table = analytics.compare(summaries)
    shown = table.copy()
    for col in ("CAGR", "Vol", "MaxDD"):
        shown[col] = shown[col].map(lambda v: f"{v:.2%}")
    for col in ("Sharpe", "Sortino", "Calmar", "Turnover/yr", "t-stat"):
        shown[col] = shown[col].map(lambda v: f"{v:.2f}")
    for col in ("Fees", "Final"):
        shown[col] = shown[col].map(lambda v: f"{v:,.0f}")

    print()
    print(shown.to_string(index=False))
    print()
    # Rank on Calmar rather than CAGR: the highest-return line is often the
    # one nobody could actually hold through its drawdown.
    best = max(summaries, key=lambda s: s.calmar if s.calmar == s.calmar else -9e9)
    print(f"Best risk-adjusted (Calmar): {best.name} — "
          f"CAGR {best.cagr:.2%}, MaxDD {best.max_drawdown:.2%}, "
          f"Calmar {best.calmar:.2f}")
    if not best.significant:
        print("Caution: that result's t-stat is under 2 — not distinguishable "
              "from luck over this sample.")

    if args.html:
        out = Path(args.html)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            report.render(results, summaries, title=title,
                          benchmark_name=args.benchmark),
            encoding="utf-8",
        )
        print(f"\nReport: {out.resolve()}")


def cmd_backtest(args):
    prices = _load(args)
    results, summaries, preset = _run_all(prices, [args.strategy], args)
    _emit(results, summaries, preset, args, f"Backtest — {summaries[0].name}")
    return 0


def cmd_compare(args):
    prices = _load(args)
    specs = _tickers(args.strategies)
    results, summaries, preset = _run_all(prices, specs, args)
    _emit(results, summaries, preset, args, "Strategy comparison")
    return 0


def cmd_rebalance(args):
    holdings = json.loads(Path(args.holdings).read_text()) if args.holdings else {}
    preset = dict(MARKETS[args.market])

    if args.targets:
        targets = json.loads(Path(args.targets).read_text())
    elif args.strategy:
        prices = _load(args)
        targets = targets_from_strategy(_strategy(args.strategy), prices)
        if not targets:
            print("Strategy produced no targets (likely still in warm-up, or "
                  "its rule says hold cash).", file=sys.stderr)
    else:
        raise SystemExit("need --targets or --strategy")

    universe = sorted(set(holdings) | set(targets))
    if args.prices:
        prices_map = json.loads(Path(args.prices).read_text())
    else:
        panel = load_prices(universe, offline=args.offline,
                            use_cache=not args.no_cache)
        prices_map = {t: float(panel[t].dropna().iloc[-1]) for t in panel.columns}
        print(f"  prices as of {panel.index[-1]:%Y-%m-%d}", file=sys.stderr)

    plan = build_plan(
        holdings, prices_map, targets,
        cash=args.cash, band=args.band,
        lot_size=args.lot_size, fractional=preset["fractional"],
        commission_bps=args.commission_bps if args.commission_bps is not None
        else preset["commission_bps"],
        slippage_bps=args.slippage_bps if args.slippage_bps is not None
        else preset["slippage_bps"],
        sell_tax_bps=args.sell_tax_bps if args.sell_tax_bps is not None
        else preset["sell_tax_bps"],
    )
    print(plan.to_text(preset["currency"]))
    return 0


def cmd_quote(args):
    prices = _load(args)
    last = prices.ffill().iloc[-1]
    changes = prices.ffill().pct_change()
    rows = []
    for ticker in prices.columns:
        series = prices[ticker].dropna()
        rows.append({
            "ticker": ticker,
            "last": last[ticker],
            "1d": changes[ticker].iloc[-1],
            "1m": series.iloc[-1] / series.iloc[-22] - 1 if len(series) > 22 else float("nan"),
            "1y": series.iloc[-1] / series.iloc[-252] - 1 if len(series) > 252 else float("nan"),
            "vol": analytics.annual_volatility(series.pct_change()),
        })
    frame = pd.DataFrame(rows).set_index("ticker")
    for col in ("1d", "1m", "1y", "vol"):
        frame[col] = frame[col].map(lambda v: "—" if v != v else f"{v:+.2%}")
    frame["last"] = frame["last"].map(lambda v: f"{v:,.2f}")
    print(frame.to_string())
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="quantdesk",
        description="Backtest, evaluate and rebalance a portfolio.",
        epilog="Research tooling. Not investment advice.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p, with_tickers=True):
        if with_tickers:
            p.add_argument("--tickers", required=True,
                           help="comma-separated, e.g. SPY,QQQ or 005930,000660")
        p.add_argument("--start", default=None)
        p.add_argument("--end", default=None)
        p.add_argument("--market", choices=sorted(MARKETS), default="us",
                       help="cost preset (kr applies the 0.18%% sell tax)")
        p.add_argument("--capital", type=float, default=None)
        p.add_argument("--commission-bps", type=float, default=None)
        p.add_argument("--slippage-bps", type=float, default=None)
        p.add_argument("--sell-tax-bps", type=float, default=None)
        p.add_argument("--benchmark", default=None,
                       help="ticker within the universe to measure alpha/beta against")
        p.add_argument("--html", default=None, help="write an HTML report here")
        p.add_argument("--offline", action="store_true",
                       help="use deterministic simulated prices (no network)")
        p.add_argument("--no-cache", action="store_true")

    p = sub.add_parser("backtest", help="run one strategy")
    common(p)
    p.add_argument("--strategy", default="buyhold",
                   help="name or name:k=v,k=v — e.g. momentum:top_n=2")
    p.set_defaults(func=cmd_backtest)

    p = sub.add_parser("compare", help="run several strategies side by side")
    common(p)
    p.add_argument("--strategies",
                   default="buyhold,riskparity,sma:window=200,momentum,dualmomentum")
    p.set_defaults(func=cmd_compare)

    p = sub.add_parser("rebalance", help="produce a concrete order list")
    p.add_argument("--tickers", default="")
    p.add_argument("--start", default=None)
    p.add_argument("--end", default=None)
    p.add_argument("--holdings", help='JSON {"TICKER": shares}')
    p.add_argument("--targets", help='JSON {"TICKER": weight}')
    p.add_argument("--prices", help='JSON {"TICKER": price} to override live quotes')
    p.add_argument("--strategy", help="derive targets from a strategy instead")
    p.add_argument("--cash", type=float, default=0.0)
    p.add_argument("--band", type=float, default=0.05,
                   help="skip legs drifting less than this from target")
    p.add_argument("--lot-size", type=int, default=1)
    p.add_argument("--market", choices=sorted(MARKETS), default="us")
    p.add_argument("--commission-bps", type=float, default=None)
    p.add_argument("--slippage-bps", type=float, default=None)
    p.add_argument("--sell-tax-bps", type=float, default=None)
    p.add_argument("--offline", action="store_true")
    p.add_argument("--no-cache", action="store_true")
    p.set_defaults(func=cmd_rebalance)

    p = sub.add_parser("quote", help="current level and trailing returns")
    common(p)
    p.set_defaults(func=cmd_quote)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except (ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
