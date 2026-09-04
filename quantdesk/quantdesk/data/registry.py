"""Ticker routing and the multi-asset loader.

``load_prices`` is the single entry point the rest of the system uses. It
routes each ticker to the right provider, falls back when a provider is
unreachable, and aligns everything onto one calendar.
"""

from __future__ import annotations

import re

import pandas as pd

from .base import DataError, Provider
from .providers import (
    AlphaVantageProvider,
    CoinGeckoProvider,
    FredProvider,
    NaverProvider,
    SyntheticProvider,
    YahooProvider,
)

_KRX_CODE = re.compile(r"^(KRX:)?\d{6}(\.(KS|KQ))?$", re.IGNORECASE)
_CRYPTO = re.compile(
    r"^(CG:.+|(BTC|ETH|SOL|XRP|ADA|DOGE|BNB|AVAX|MATIC|LINK|DOT|LTC)-[A-Z]{3,4})$",
    re.IGNORECASE,
)

_PROVIDERS: dict[str, type[Provider]] = {
    "yahoo": YahooProvider,
    "naver": NaverProvider,
    "fred": FredProvider,
    "coingecko": CoinGeckoProvider,
    "alphavantage": AlphaVantageProvider,
    "synthetic": SyntheticProvider,
}


def route(ticker: str) -> list[str]:
    """Provider names to try for ``ticker``, best first.

    An explicit ``provider:symbol`` prefix always wins; otherwise the shape of
    the ticker decides, with a fallback chain for the ambiguous cases.
    """
    t = ticker.strip()
    head, sep, _ = t.partition(":")
    if sep and head.lower() in _PROVIDERS:
        return [head.lower()]

    if _KRX_CODE.match(t):
        return ["naver", "yahoo"]
    if _CRYPTO.match(t):
        return ["coingecko", "yahoo"]
    # Plain equity/ETF ticker: Yahoo is the broadest, AlphaVantage is the
    # backup for when Yahoo blocks the caller's IP.
    return ["yahoo", "alphavantage"]


def strip_prefix(ticker: str) -> str:
    head, sep, tail = ticker.partition(":")
    if sep and head.lower() in _PROVIDERS and head.lower() != "fred":
        return tail or ticker
    return ticker


def get_history(ticker: str, start: str | None = None, end: str | None = None,
                *, offline: bool = False, use_cache: bool = True,
                errors: list[str] | None = None) -> pd.DataFrame:
    """Fetch one ticker, walking the fallback chain until a provider answers."""
    if offline:
        return SyntheticProvider(use_cache=False).history(ticker, start, end)

    failures = []
    for name in route(ticker):
        provider = _PROVIDERS[name](use_cache=use_cache)
        symbol = ticker if name == "fred" else strip_prefix(ticker)
        try:
            frame = provider.history(symbol, start, end)
        except DataError as exc:
            failures.append(f"{name}: {exc}")
            continue
        if not frame.empty:
            frame.attrs["provider"] = name
            frame.attrs["ticker"] = ticker
            return frame
        failures.append(f"{name}: empty range")

    detail = "; ".join(failures) or "no provider matched"
    if errors is not None:
        errors.append(f"{ticker} -> {detail}")
    raise DataError(f"could not load {ticker!r} ({detail})")


def load_prices(tickers: list[str], start: str | None = None,
                end: str | None = None, *, field: str = "close",
                offline: bool = False, use_cache: bool = True,
                min_coverage: float = 0.0) -> pd.DataFrame:
    """Load one field for many tickers onto a shared calendar.

    Tickers that fail to load are skipped with a warning rather than killing
    the whole run — one dead symbol should not cost you the other nine.

    The union of all trading days is used as the index, then forward-filled:
    that keeps a KRX holiday from silently dropping a US session out of a
    mixed-market portfolio. Leading NaNs (before a ticker listed) are kept as
    NaN so the engine knows the asset was not yet investable.
    """
    if not tickers:
        raise ValueError("load_prices needs at least one ticker")

    series: dict[str, pd.Series] = {}
    problems: list[str] = []
    for ticker in tickers:
        try:
            frame = get_history(
                ticker, start, end, offline=offline, use_cache=use_cache,
                errors=problems,
            )
        except DataError as exc:
            problems.append(str(exc))
            continue
        series[ticker] = frame[field].rename(ticker)

    if not series:
        raise DataError("no tickers could be loaded: " + "; ".join(problems))

    panel = pd.concat(series.values(), axis=1).sort_index()
    panel = panel.ffill()

    if min_coverage > 0:
        coverage = panel.notna().mean()
        keep = coverage[coverage >= min_coverage].index.tolist()
        dropped = sorted(set(panel.columns) - set(keep))
        if dropped:
            problems.append(f"dropped for <{min_coverage:.0%} coverage: {dropped}")
        panel = panel[keep]

    panel.attrs["problems"] = problems
    return panel
