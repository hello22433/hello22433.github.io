"""Concrete price sources.

Each one speaks a different wire format; all of them hand back the OHLCV
contract from :mod:`quantdesk.data.base`.

Availability notes (measured, not assumed):

==============  ====  =========================================================
Provider        Key   Covers
==============  ====  =========================================================
Yahoo           no    global equities/ETFs/FX/crypto. Blocks datacentre IPs
                      with HTTP 429 — works from a home connection, usually
                      not from a cloud VM or CI runner.
Naver           no    Korean listings (KOSPI/KOSDAQ) by 6-digit code.
FRED            no    macro series + the S&P 500 index level. Index only, so
                      no dividends and no volume.
CoinGecko       no    crypto in any quote currency. Daily closes only, so
                      open/high/low are set equal to the close.
AlphaVantage    yes   global equities, split/dividend adjusted. Free key is
                      ~25 requests/day; the literal key ``demo`` works for IBM.
==============  ====  =========================================================
"""

from __future__ import annotations

import csv
import io
import json
import os
import re

import numpy as np
import pandas as pd

from .base import DataError, Provider, http_get


class YahooProvider(Provider):
    """Yahoo Finance chart API — the broadest free source when reachable."""

    name = "yahoo"

    def fetch(self, symbol: str) -> pd.DataFrame:
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
            "?range=max&interval=1d&events=div%2Csplit"
        )
        payload = json.loads(http_get(url))
        chart = payload.get("chart") or {}
        if chart.get("error"):
            raise DataError(f"yahoo: {chart['error']}")
        results = chart.get("result") or []
        if not results:
            raise DataError(f"yahoo returned no result for {symbol!r}")

        result = results[0]
        stamps = result.get("timestamp") or []
        quote = (result.get("indicators", {}).get("quote") or [{}])[0]
        frame = pd.DataFrame(
            {
                "open": quote.get("open"),
                "high": quote.get("high"),
                "low": quote.get("low"),
                "close": quote.get("close"),
                "volume": quote.get("volume"),
            },
            index=pd.to_datetime(stamps, unit="s", utc=True).tz_convert(None),
        )

        # Prefer the split/dividend-adjusted close: an unadjusted series turns
        # every split into a fake -50% day.
        adj = (result.get("indicators", {}).get("adjclose") or [{}])[0].get("adjclose")
        if adj is not None:
            adjusted = pd.Series(adj, index=frame.index, dtype="float64")
            ratio = (adjusted / frame["close"]).replace([np.inf, -np.inf], np.nan)
            ratio = ratio.fillna(1.0)
            for col in ("open", "high", "low"):
                frame[col] = frame[col] * ratio
            frame["close"] = adjusted

        return frame.dropna(subset=["close"])


class NaverProvider(Provider):
    """Korean listings via Naver's ``siseJson`` endpoint.

    Accepts ``005930``, ``005930.KS``, or ``KRX:005930``. Naver returns
    Python-ish rows with single quotes, so the payload is parsed by regex
    rather than handed to ``json.loads``.
    """

    name = "naver"
    _ROW = re.compile(
        r'\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)'
    )

    @staticmethod
    def code(symbol: str) -> str:
        raw = symbol.upper().replace("KRX:", "").split(".")[0]
        if not re.fullmatch(r"\d{6}", raw):
            raise DataError(f"naver expects a 6-digit KRX code, got {symbol!r}")
        return raw

    def fetch(self, symbol: str) -> pd.DataFrame:
        code = self.code(symbol)
        url = (
            "https://api.finance.naver.com/siseJson.naver"
            f"?symbol={code}&requestType=1&startTime=19900101"
            f"&endTime={pd.Timestamp.today():%Y%m%d}&timeframe=day"
        )
        text = http_get(url).decode("utf-8", errors="replace")
        rows = self._ROW.findall(text)
        if not rows:
            raise DataError(f"naver returned no rows for {code}")

        frame = pd.DataFrame(
            [
                {
                    "open": float(o), "high": float(h), "low": float(lo),
                    "close": float(c), "volume": float(v),
                }
                for _, o, h, lo, c, v in rows
            ],
            index=pd.to_datetime([r[0] for r in rows], format="%Y%m%d"),
        )
        return frame


class FredProvider(Provider):
    """St. Louis Fed series (``FRED:SP500``, ``FRED:DGS10``, ``FRED:VIXCLS``…).

    These are index/rate levels, not tradable prices: there is no volume and
    no dividend adjustment, so treat a FRED series as a reference signal
    rather than something to backtest holding.
    """

    name = "fred"
    cache_ttl = 12 * 3600

    @staticmethod
    def series_id(symbol: str) -> str:
        return symbol.upper().replace("FRED:", "").strip()

    def fetch(self, symbol: str) -> pd.DataFrame:
        sid = self.series_id(symbol)
        url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
        text = http_get(url).decode("utf-8", errors="replace")
        reader = csv.reader(io.StringIO(text))
        header = next(reader, None)
        if not header or len(header) < 2:
            raise DataError(f"fred: unexpected CSV header for {sid}")

        dates, values = [], []
        for row in reader:
            if len(row) < 2 or row[1] in (".", "", "NaN"):
                continue  # FRED writes "." for holidays / missing observations
            dates.append(row[0])
            values.append(float(row[1]))
        if not values:
            raise DataError(f"fred: series {sid} has no observations")

        close = pd.Series(values, index=pd.to_datetime(dates), dtype="float64")
        return pd.DataFrame(
            {
                "open": close, "high": close, "low": close, "close": close,
                "volume": np.nan,
            }
        )


class CoinGeckoProvider(Provider):
    """Crypto daily closes. ``BTC-USD``, ``ETH-KRW``, or ``CG:solana``."""

    name = "coingecko"
    ALIASES = {
        "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana",
        "XRP": "ripple", "ADA": "cardano", "DOGE": "dogecoin",
        "BNB": "binancecoin", "AVAX": "avalanche-2", "MATIC": "matic-network",
        "LINK": "chainlink", "DOT": "polkadot", "LTC": "litecoin",
    }

    @classmethod
    def parse(cls, symbol: str) -> tuple[str, str]:
        raw = symbol.strip()
        if raw.upper().startswith("CG:"):
            body = raw[3:]
            coin, _, quote = body.partition("/")
            return coin.lower(), (quote or "usd").lower()
        base, _, quote = raw.upper().partition("-")
        return cls.ALIASES.get(base, base.lower()), (quote or "USD").lower()

    def fetch(self, symbol: str) -> pd.DataFrame:
        coin, quote = self.parse(symbol)
        url = (
            f"https://api.coingecko.com/api/v3/coins/{coin}/market_chart"
            f"?vs_currency={quote}&days=max&interval=daily"
        )
        payload = json.loads(http_get(url))
        prices = payload.get("prices") or []
        if not prices:
            raise DataError(f"coingecko: no prices for {coin}/{quote}")

        volumes = dict(payload.get("total_volumes") or [])
        stamps = [p[0] for p in prices]
        close = pd.Series(
            [float(p[1]) for p in prices],
            index=pd.to_datetime(stamps, unit="ms"),
            dtype="float64",
        )
        # Daily snapshots only, so OHLC collapses onto the close. Recorded
        # honestly here rather than faked with a random intraday range.
        return pd.DataFrame(
            {
                "open": close, "high": close, "low": close, "close": close,
                "volume": [float(volumes.get(s, np.nan)) for s in stamps],
            }
        )


class AlphaVantageProvider(Provider):
    """Split/dividend-adjusted global equities. Needs ``ALPHAVANTAGE_API_KEY``.

    The free tier is roughly 25 calls/day, so the on-disk cache does most of
    the work; the literal key ``demo`` only ever returns IBM.
    """

    name = "alphavantage"
    cache_ttl = 24 * 3600

    def __init__(self, *args, api_key: str | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.api_key = api_key or os.environ.get("ALPHAVANTAGE_API_KEY", "demo")

    def fetch(self, symbol: str) -> pd.DataFrame:
        url = (
            "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY"
            f"&symbol={symbol}&outputsize=full&apikey={self.api_key}"
        )
        payload = json.loads(http_get(url))
        for key in ("Note", "Information", "Error Message"):
            if key in payload:
                raise DataError(f"alphavantage: {payload[key]}")

        series = payload.get("Time Series (Daily)")
        if not series:
            raise DataError(f"alphavantage returned no series for {symbol!r}")

        return pd.DataFrame(
            [
                {
                    "open": float(row["1. open"]),
                    "high": float(row["2. high"]),
                    "low": float(row["3. low"]),
                    "close": float(row["4. close"]),
                    "volume": float(row["5. volume"]),
                }
                for row in series.values()
            ],
            index=pd.to_datetime(list(series.keys())),
        )


class SyntheticProvider(Provider):
    """Deterministic simulated prices for offline runs and tests."""

    name = "synthetic"

    def history(self, symbol, start=None, end=None):  # bypass cache entirely
        from .base import _slice, synthetic_history

        seed = abs(hash(symbol)) % (2 ** 31)
        frame = synthetic_history(symbol, seed=seed)
        return _slice(frame, start, end)

    def fetch(self, symbol: str) -> pd.DataFrame:  # pragma: no cover
        from .base import synthetic_history

        return synthetic_history(symbol, seed=abs(hash(symbol)) % (2 ** 31))
