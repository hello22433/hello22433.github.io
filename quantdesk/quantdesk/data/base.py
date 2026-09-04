"""Common contract for every market-data provider.

Every provider returns the exact same shape so the rest of the system never
has to care where a price came from:

    pandas.DataFrame
        index   : DatetimeIndex, tz-naive, normalised to midnight, ascending,
                  strictly increasing (no duplicate sessions)
        columns : open, high, low, close, volume  (float64, volume may be NaN)

Anything that does not satisfy that is a bug in the provider, so ``normalise``
raises instead of quietly passing bad data into a backtest.
"""

from __future__ import annotations

import abc
import datetime as dt
import gzip
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

OHLCV_COLUMNS = ["open", "high", "low", "close", "volume"]

DEFAULT_CACHE_DIR = Path(
    os.environ.get("QUANTDESK_CACHE", Path.home() / ".quantdesk" / "cache")
)

_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


class DataError(RuntimeError):
    """A provider could not produce usable data for a symbol."""


def http_get(url: str, *, timeout: float = 30.0, headers: dict | None = None,
             retries: int = 3, backoff: float = 1.5) -> bytes:
    """GET with retries on transient failures.

    Retries 429/5xx and network errors; a 404 or other 4xx fails immediately
    because retrying a bad symbol just wastes the caller's time.
    """
    hdrs = {"User-Agent": _USER_AGENT, "Accept": "*/*"}
    if headers:
        hdrs.update(headers)

    last: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            last = exc
            transient = exc.code == 429 or exc.code >= 500
            if not transient or attempt == retries - 1:
                raise DataError(f"HTTP {exc.code} for {url}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
            if attempt == retries - 1:
                raise DataError(f"network failure for {url}: {exc}") from exc
        time.sleep(backoff * (2 ** attempt))

    raise DataError(f"unreachable: {url} ({last})")


def normalise(frame: pd.DataFrame, symbol: str) -> pd.DataFrame:
    """Coerce a provider's raw frame into the OHLCV contract, or raise."""
    if frame is None or frame.empty:
        raise DataError(f"no rows returned for {symbol!r}")

    out = frame.copy()
    missing = [c for c in OHLCV_COLUMNS if c not in out.columns]
    if missing:
        raise DataError(f"{symbol!r}: provider omitted columns {missing}")

    out = out[OHLCV_COLUMNS].astype("float64")
    out.index = pd.to_datetime(out.index).tz_localize(None).normalize()
    out = out[~out.index.duplicated(keep="last")].sort_index()
    out.index.name = "date"

    # A zero or negative close makes every return calculation downstream
    # meaningless, so drop those sessions rather than propagate inf.
    out = out[out["close"] > 0]
    if out.empty:
        raise DataError(f"{symbol!r}: no sessions with a positive close")
    return out


def _slice(frame: pd.DataFrame, start: str | None, end: str | None) -> pd.DataFrame:
    if start is not None:
        frame = frame[frame.index >= pd.Timestamp(start).normalize()]
    if end is not None:
        frame = frame[frame.index <= pd.Timestamp(end).normalize()]
    return frame


class Provider(abc.ABC):
    """Base class for a price source.

    Subclasses implement :meth:`fetch` (raw download for the widest range the
    source offers); caching and slicing are handled here so every provider
    gets them identically.
    """

    name: str = "provider"
    #: seconds a cached download stays fresh
    cache_ttl: float = 6 * 3600

    def __init__(self, cache_dir: Path | str | None = None, use_cache: bool = True):
        self.cache_dir = Path(cache_dir) if cache_dir else DEFAULT_CACHE_DIR
        self.use_cache = use_cache

    @abc.abstractmethod
    def fetch(self, symbol: str) -> pd.DataFrame:
        """Download the full available history for ``symbol``."""

    def history(self, symbol: str, start: str | None = None,
                end: str | None = None) -> pd.DataFrame:
        cached = self._read_cache(symbol)
        if cached is not None:
            return _slice(cached, start, end)

        frame = normalise(self.fetch(symbol), symbol)
        self._write_cache(symbol, frame)
        return _slice(frame, start, end)

    # -- cache ---------------------------------------------------------
    def _cache_path(self, symbol: str) -> Path:
        digest = hashlib.sha256(f"{self.name}:{symbol}".encode()).hexdigest()[:20]
        return self.cache_dir / f"{self.name}_{digest}.csv.gz"

    def _read_cache(self, symbol: str) -> pd.DataFrame | None:
        if not self.use_cache:
            return None
        path = self._cache_path(symbol)
        if not path.exists():
            return None
        if time.time() - path.stat().st_mtime > self.cache_ttl:
            return None
        try:
            frame = pd.read_csv(path, index_col=0, parse_dates=True)
        except Exception:
            return None
        try:
            return normalise(frame, symbol)
        except DataError:
            return None

    def _write_cache(self, symbol: str, frame: pd.DataFrame) -> None:
        if not self.use_cache:
            return
        path = self._cache_path(symbol)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        frame.to_csv(tmp)
        # gzip separately so a crash mid-write never leaves a corrupt cache file
        with open(tmp, "rb") as src, gzip.open(path, "wb") as dst:
            dst.write(src.read())
        tmp.unlink(missing_ok=True)


def synthetic_history(symbol: str, days: int = 1000, seed: int = 0,
                      start: str = "2020-01-01", annual_drift: float = 0.08,
                      annual_vol: float = 0.20, price0: float = 100.0) -> pd.DataFrame:
    """Deterministic geometric-Brownian series on business days.

    Used by the test-suite and by ``--offline`` so the engine can be exercised
    without a network. It is a simulator, never a stand-in for real prices.
    """
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range(start=start, periods=days)
    dt_ = 1.0 / 252.0
    shocks = rng.normal(
        (annual_drift - 0.5 * annual_vol ** 2) * dt_,
        annual_vol * np.sqrt(dt_),
        size=days,
    )
    close = price0 * np.exp(np.cumsum(shocks))
    intraday = np.abs(rng.normal(0, 0.004, size=days))
    frame = pd.DataFrame(
        {
            "open": close * (1 - intraday / 2),
            "high": close * (1 + intraday),
            "low": close * (1 - intraday),
            "close": close,
            "volume": rng.integers(1e5, 1e7, size=days).astype(float),
        },
        index=idx,
    )
    return normalise(frame, symbol)
