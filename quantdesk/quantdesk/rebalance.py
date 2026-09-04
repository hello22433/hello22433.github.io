"""Turn target weights into the concrete orders you actually place.

A backtest tells you what to hold. This module tells you what to *do* on
Monday morning: exact share counts, in an order that never spends cash you
do not have yet.

Three details here are what separate a usable order list from a spreadsheet
that loses money at the edges:

* **Whole shares.** KRX has no fractional trading, and neither do most
  brokers outside a handful of US apps. A plan that says "buy 13.7 shares" is
  not a plan.
* **A no-trade band.** Rebalancing back to target on every 0.3% of drift
  costs more in fees and spread than the drift costs in tracking error. The
  band suppresses those trades; ``5%`` is a reasonable default for a monthly
  or quarterly cadence.
* **Sell before buy.** The order list is emitted sells-first, so proceeds
  from the sells fund the buys. Reverse it and the buys bounce on a
  fully-invested account.

Nothing here places an order. It prints a plan for a human to review and
enter. That boundary is deliberate.
"""

from __future__ import annotations

import dataclasses
import math

import numpy as np
import pandas as pd


@dataclasses.dataclass
class Order:
    ticker: str
    side: str            # "BUY" or "SELL"
    shares: int
    price: float
    notional: float
    reason: str

    def __str__(self) -> str:
        return (
            f"{self.side:4s} {self.shares:>10,d} x {self.ticker:<12s} "
            f"@ {self.price:>12,.2f} = {self.notional:>14,.0f}"
        )


@dataclasses.dataclass
class RebalancePlan:
    orders: list[Order]
    current: pd.DataFrame        # per-ticker before/after detail
    total_value: float
    cash_before: float
    cash_after: float
    estimated_cost: float
    skipped: list[str]

    @property
    def turnover(self) -> float:
        gross = sum(abs(o.notional) for o in self.orders)
        return gross / self.total_value if self.total_value else 0.0

    def to_text(self, currency: str = "KRW") -> str:
        lines = [
            "=" * 74,
            "REBALANCE PLAN",
            "=" * 74,
            f"Portfolio value : {self.total_value:>18,.0f} {currency}",
            f"Cash before     : {self.cash_before:>18,.0f} {currency}",
            f"Cash after      : {self.cash_after:>18,.0f} {currency}",
            f"Turnover        : {self.turnover:>18.2%}",
            f"Est. cost       : {self.estimated_cost:>18,.0f} {currency}",
            "",
        ]
        if not self.orders:
            lines.append("No orders — every position is already inside its band.")
        else:
            lines.append("ORDERS (execute in this order — sells fund the buys)")
            lines.append("-" * 74)
            lines.extend(str(o) for o in self.orders)
        if self.skipped:
            lines += ["", "SKIPPED", "-" * 74, *(f"  {s}" for s in self.skipped)]
        lines += [
            "",
            "-" * 74,
            "Review every line before entering it. Prices move between planning",
            "and execution; use limit orders and re-check size against live quotes.",
            "=" * 74,
        ]
        return "\n".join(lines)


def build_plan(
    holdings: dict[str, float],
    prices: dict[str, float],
    targets: dict[str, float],
    *,
    cash: float = 0.0,
    band: float = 0.05,
    lot_size: int = 1,
    fractional: bool = False,
    commission_bps: float = 1.5,
    slippage_bps: float = 5.0,
    sell_tax_bps: float = 0.0,
    cash_buffer: float = 0.005,
) -> RebalancePlan:
    """Compute orders that move ``holdings`` toward ``targets``.

    Parameters
    ----------
    holdings
        ``{ticker: shares_held}``. Tickers absent from ``targets`` are sold
        down to zero.
    prices
        ``{ticker: last_price}``. Must cover every ticker in either dict.
    targets
        ``{ticker: weight}`` summing to <= 1.0; the remainder stays in cash.
    band
        Skip any leg whose drift from target is under this fraction of the
        portfolio. ``0`` disables the band and rebalances exactly.
    cash_buffer
        Fraction of the portfolio held back from buys so a price tick between
        planning and execution does not bounce the last order.
    """
    universe = set(holdings) | set(targets)
    missing = sorted(t for t in universe if t not in prices or not np.isfinite(prices[t]))
    if missing:
        raise ValueError(f"no price supplied for: {missing}")

    holdings_value = sum(holdings.get(t, 0.0) * prices[t] for t in holdings)
    total = holdings_value + cash
    if total <= 0:
        raise ValueError("portfolio value must be positive")

    weight_sum = sum(targets.values())
    if weight_sum > 1.0 + 1e-9:
        raise ValueError(
            f"target weights sum to {weight_sum:.4f}; this planner does not use margin"
        )

    rows, orders, skipped = [], [], []
    investable = total * (1.0 - cash_buffer)

    for ticker in sorted(universe):
        price = float(prices[ticker])
        held = float(holdings.get(ticker, 0.0))
        target_w = float(targets.get(ticker, 0.0))

        current_value = held * price
        current_w = current_value / total
        target_value = investable * target_w
        delta_value = target_value - current_value

        row = {
            "ticker": ticker, "price": price, "shares_held": held,
            "value": current_value, "weight": current_w,
            "target_weight": target_w, "drift": current_w - target_w,
            "delta_value": delta_value, "shares_delta": 0,
        }

        if abs(current_w - target_w) < band:
            if abs(delta_value) > 0:
                skipped.append(
                    f"{ticker}: drift {current_w - target_w:+.2%} inside "
                    f"{band:.1%} band"
                )
            rows.append(row)
            continue

        side = "BUY" if delta_value > 0 else "SELL"
        signed = 1 if delta_value > 0 else -1
        fill_px = price * (1 + signed * slippage_bps / 1e4)
        raw_shares = abs(delta_value) / fill_px

        if fractional:
            shares = raw_shares
        else:
            step = max(int(lot_size), 1)
            shares = math.floor(raw_shares / step) * step

        if side == "SELL":
            shares = min(shares, math.floor(held) if not fractional else held)
        if shares <= 0:
            skipped.append(
                f"{ticker}: {side} of {raw_shares:.2f} sh rounds to 0 "
                f"(lot size {lot_size})"
            )
            rows.append(row)
            continue

        notional = shares * fill_px
        row["shares_delta"] = shares if side == "BUY" else -shares
        rows.append(row)
        orders.append(
            Order(
                ticker=ticker, side=side,
                shares=int(shares) if not fractional else shares,
                price=fill_px, notional=notional,
                reason=f"{current_w:.2%} -> {target_w:.2%}",
            )
        )

    # Sells first so their proceeds are available to the buys.
    orders.sort(key=lambda o: (o.side != "SELL", -o.notional))

    # Walk the list with a running cash balance and trim any buy that cannot
    # be funded, rather than emitting a plan that fails at the broker.
    running, cost, funded = cash, 0.0, []
    for order in orders:
        fee_bps = commission_bps + (sell_tax_bps if order.side == "SELL" else 0.0)
        fee = order.notional * fee_bps / 1e4

        if order.side == "SELL":
            running += order.notional - fee
            cost += fee
            funded.append(order)
            continue

        if order.notional + fee > running:
            affordable_cash = max(running - fee, 0.0)
            shares = affordable_cash / order.price
            step = max(int(lot_size), 1)
            shares = shares if fractional else math.floor(shares / step) * step
            if shares <= 0:
                skipped.append(f"{order.ticker}: BUY skipped — insufficient cash")
                continue
            notional = shares * order.price
            fee = notional * commission_bps / 1e4
            order = dataclasses.replace(
                order,
                shares=int(shares) if not fractional else shares,
                notional=notional,
                reason=order.reason + " (trimmed to available cash)",
            )
        running -= order.notional + fee
        cost += fee
        funded.append(order)

    return RebalancePlan(
        orders=funded,
        current=pd.DataFrame(rows).set_index("ticker") if rows else pd.DataFrame(),
        total_value=total,
        cash_before=cash,
        cash_after=running,
        estimated_cost=cost,
        skipped=skipped,
    )


def targets_from_strategy(strategy, prices: pd.DataFrame) -> dict[str, float]:
    """Ask a strategy what it wants to hold as of the last row of ``prices``.

    This is the bridge from backtest to live: the same code path the backtest
    exercised, run once on today's data.
    """
    return strategy.target_weights(prices) or {}
