"""quantdesk — a portfolio research and rebalancing toolkit.

Research tooling only. Nothing here places an order, and no output is a
prediction or investment advice.
"""

__version__ = "0.1.0"

from .backtest.engine import CostModel, Strategy, run_backtest
from .data.registry import get_history, load_prices
from .rebalance import build_plan

__all__ = [
    "CostModel", "Strategy", "run_backtest",
    "get_history", "load_prices", "build_plan", "__version__",
]
