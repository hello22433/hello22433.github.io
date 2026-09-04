"""Self-contained HTML report — inline SVG, no CDN, no build step.

Opens straight from the filesystem and prints cleanly. Charts are hand-drawn
SVG rather than a plotting library so the file stays a single artefact you can
email or archive.
"""

from __future__ import annotations

import html
from datetime import datetime

import numpy as np
import pandas as pd

from . import analytics

_PALETTE = ["#2563eb", "#e8590c", "#0d9488", "#7c3aed", "#b91c1c", "#0369a1"]


def _fmt_pct(x, digits=2):
    return "—" if x is None or not np.isfinite(x) else f"{x:.{digits}%}"


def _fmt_num(x, digits=2):
    return "—" if x is None or not np.isfinite(x) else f"{x:,.{digits}f}"


def _fmt_money(x):
    return "—" if x is None or not np.isfinite(x) else f"{x:,.0f}"


def _path(series: pd.Series, width: int, height: int, pad: int,
          logscale: bool = False, floor_zero: bool = False) -> tuple[str, float, float]:
    """Build an SVG polyline for ``series`` scaled into the plot box."""
    s = series.dropna()
    if len(s) < 2:
        return "", 0.0, 0.0
    y = np.log(s.values) if logscale else s.values
    lo, hi = (min(float(y.min()), 0.0) if floor_zero else float(y.min())), float(y.max())
    if hi == lo:
        hi = lo + 1e-9
    xs = np.linspace(pad, width - pad, len(s))
    ys = height - pad - (y - lo) / (hi - lo) * (height - 2 * pad)
    pts = " ".join(f"{x:.1f},{v:.1f}" for x, v in zip(xs, ys))
    return pts, lo, hi


def _equity_chart(curves: dict[str, pd.Series], width=980, height=340, pad=44) -> str:
    """Log-scale growth-of-1 chart. Log scale so a 50% move reads the same
    size early and late — on a linear axis recent years visually dominate."""
    if not curves:
        return ""
    norm = {k: (v / v.dropna().iloc[0]) for k, v in curves.items() if len(v.dropna()) > 1}
    if not norm:
        return ""

    combined = pd.concat(norm.values())
    lo, hi = float(np.log(combined.min())), float(np.log(combined.max()))
    if hi == lo:
        hi = lo + 1e-9

    parts = [
        f'<svg viewBox="0 0 {width} {height}" class="chart" '
        f'role="img" aria-label="Growth of 1 unit, log scale">'
    ]
    # gridlines at round multiples
    for mult in [0.5, 1, 2, 4, 8, 16, 32, 64]:
        lv = np.log(mult)
        if not (lo <= lv <= hi):
            continue
        y = height - pad - (lv - lo) / (hi - lo) * (height - 2 * pad)
        parts.append(
            f'<line x1="{pad}" y1="{y:.1f}" x2="{width - pad}" y2="{y:.1f}" '
            f'class="grid"/>'
            f'<text x="{pad - 6}" y="{y + 4:.1f}" class="axis" '
            f'text-anchor="end">{mult:g}x</text>'
        )

    first = next(iter(norm.values()))
    for i, (label, series) in enumerate(norm.items()):
        s = series.dropna()
        xs = np.linspace(pad, width - pad, len(s))
        ys = height - pad - (np.log(s.values) - lo) / (hi - lo) * (height - 2 * pad)
        pts = " ".join(f"{x:.1f},{v:.1f}" for x, v in zip(xs, ys))
        colour = _PALETTE[i % len(_PALETTE)]
        parts.append(f'<polyline points="{pts}" fill="none" stroke="{colour}" '
                     f'stroke-width="2" stroke-linejoin="round"/>')

    idx = first.dropna().index
    for frac in (0.0, 0.25, 0.5, 0.75, 1.0):
        pos = int(frac * (len(idx) - 1))
        x = pad + frac * (width - 2 * pad)
        parts.append(
            f'<text x="{x:.1f}" y="{height - pad + 18}" class="axis" '
            f'text-anchor="middle">{idx[pos]:%Y-%m}</text>'
        )

    legend = " ".join(
        f'<span class="key"><i style="background:{_PALETTE[i % len(_PALETTE)]}"></i>'
        f"{html.escape(k)}</span>"
        for i, k in enumerate(norm)
    )
    parts.append("</svg>")
    return f'<div class="legend">{legend}</div>' + "".join(parts)


def _drawdown_chart(equity: pd.Series, width=980, height=200, pad=44) -> str:
    dd = analytics.drawdown_series(equity).dropna()
    if len(dd) < 2:
        return ""
    lo = float(dd.min())
    lo = min(lo, -1e-9)
    xs = np.linspace(pad, width - pad, len(dd))
    ys = pad + (dd.values / lo) * (height - 2 * pad)
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in zip(xs, ys))
    area = f"{pad},{pad} {pts} {width - pad},{pad}"
    ticks = "".join(
        f'<line x1="{pad}" y1="{pad + f * (height - 2 * pad):.1f}" '
        f'x2="{width - pad}" y2="{pad + f * (height - 2 * pad):.1f}" class="grid"/>'
        f'<text x="{pad - 6}" y="{pad + f * (height - 2 * pad) + 4:.1f}" '
        f'class="axis" text-anchor="end">{lo * f:.0%}</text>'
        for f in (0.0, 0.5, 1.0)
    )
    return (
        f'<svg viewBox="0 0 {width} {height}" class="chart" role="img" '
        f'aria-label="Drawdown from prior peak">{ticks}'
        f'<polygon points="{area}" fill="#b91c1c" opacity="0.16"/>'
        f'<polyline points="{pts}" fill="none" stroke="#b91c1c" stroke-width="1.6"/>'
        f"</svg>"
    )


def _monthly_grid(equity: pd.Series) -> str:
    table = analytics.monthly_table(equity)
    if table.empty:
        return ""
    vals = table.to_numpy(dtype="float64")
    scale = np.nanmax(np.abs(vals)) or 1.0

    head = "".join(f"<th>{m}</th>" for m in
                   ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])
    rows = []
    for year, row in table.iterrows():
        cells = []
        for month in range(1, 13):
            v = row.get(month, np.nan)
            if not np.isfinite(v):
                cells.append('<td class="na"></td>')
                continue
            alpha = min(abs(v) / scale, 1.0) * 0.75
            colour = "13,148,136" if v >= 0 else "185,28,28"
            cells.append(
                f'<td style="background:rgba({colour},{alpha:.3f})">{v:.1%}</td>'
            )
        annual = (1 + row.dropna()).prod() - 1 if row.notna().any() else np.nan
        cells.append(f'<td class="yr">{_fmt_pct(annual, 1)}</td>')
        rows.append(f"<tr><th>{year}</th>{''.join(cells)}</tr>")

    return (
        f'<table class="months"><thead><tr><th></th>{head}<th class="yr">Year</th>'
        f"</tr></thead><tbody>{''.join(rows)}</tbody></table>"
    )


def _summary_table(summaries: list[analytics.Summary]) -> str:
    metrics = [
        ("CAGR", lambda s: _fmt_pct(s.cagr), "Compound annual growth rate"),
        ("Total return", lambda s: _fmt_pct(s.total_return), "Over the full period"),
        ("Volatility", lambda s: _fmt_pct(s.volatility), "Annualised std-dev of daily returns"),
        ("Sharpe", lambda s: _fmt_num(s.sharpe), "Return per unit of total risk"),
        ("Sortino", lambda s: _fmt_num(s.sortino), "Return per unit of downside risk"),
        ("Max drawdown", lambda s: _fmt_pct(s.max_drawdown), "Worst peak-to-trough loss"),
        ("Calmar", lambda s: _fmt_num(s.calmar), "CAGR / max drawdown"),
        ("VaR 95%", lambda s: _fmt_pct(s.var95), "Daily loss exceeded 1 day in 20"),
        ("CVaR 95%", lambda s: _fmt_pct(s.cvar95), "Average loss on those worst days"),
        ("Win rate", lambda s: _fmt_pct(s.win_rate, 1), "Share of up days"),
        ("Worst day", lambda s: _fmt_pct(s.worst_day), "Single worst session"),
        ("Exposure", lambda s: _fmt_pct(s.exposure, 1), "Average share of capital invested"),
        ("Turnover / yr", lambda s: _fmt_num(s.avg_turnover_annual), "One-way, x portfolio value"),
        ("Fees paid", lambda s: _fmt_money(s.fees_paid), "Commission + slippage + tax"),
        ("Fee drag / yr", lambda s: _fmt_pct(s.fee_drag_annual), "Annual cost as % of capital"),
        ("Beta", lambda s: _fmt_num(s.beta), "Sensitivity to the benchmark"),
        ("Alpha / yr", lambda s: _fmt_pct(s.alpha), "Annualised excess over beta exposure"),
        ("t-stat", lambda s: _fmt_num(s.t_stat), "|t| > 2 suggests a real edge"),
        ("Final value", lambda s: _fmt_money(s.final), ""),
    ]
    head = "".join(f"<th>{html.escape(s.name)}</th>" for s in summaries)
    rows = []
    for label, fn, tip in metrics:
        cells = "".join(f"<td>{fn(s)}</td>" for s in summaries)
        note = f'<span class="tip" title="{html.escape(tip)}">?</span>' if tip else ""
        rows.append(f"<tr><th>{label}{note}</th>{cells}</tr>")
    return (
        f'<table class="stats"><thead><tr><th>Metric</th>{head}</tr></thead>'
        f"<tbody>{''.join(rows)}</tbody></table>"
    )


_CSS = """
:root{--bg:#ffffff;--fg:#14171f;--muted:#5b6472;--line:#e3e7ee;--card:#f7f9fc;
--accent:#2563eb;--warn:#8a5a00;--warnbg:#fff8e6;--warnline:#e8c169}
@media(prefers-color-scheme:dark){:root{--bg:#11141a;--fg:#e7eaf0;--muted:#9aa4b3;
--line:#252a34;--card:#171b22;--accent:#6ea8fe;--warn:#e8c169;--warnbg:#241f12;
--warnline:#5c4a1e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",
"Apple SD Gothic Neo","Malgun Gothic",sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:40px 24px 72px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
h2{font-size:17px;margin:40px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.sub{color:var(--muted);font-size:13px;margin:0 0 28px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.card .v{font-size:21px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:right}
thead th{text-align:right;font-weight:600;color:var(--muted);font-size:11px;
text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
tbody th,thead th:first-child{text-align:left;font-weight:500;white-space:nowrap}
.months td{text-align:right;font-size:12px;padding:5px 7px}
.months td.na{background:transparent}
.months .yr{font-weight:600;border-left:1px solid var(--line)}
.chart{width:100%;height:auto;display:block;margin:8px 0 4px}
.grid{stroke:var(--line);stroke-width:1}
.axis{fill:var(--muted);font-size:10px}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin:4px 0 8px;font-size:12px;color:var(--muted)}
.key i{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:6px;
vertical-align:-1px}
.tip{display:inline-block;width:14px;height:14px;line-height:14px;text-align:center;
border-radius:50%;background:var(--line);color:var(--muted);font-size:10px;margin-left:6px;
cursor:help}
.note{background:var(--warnbg);border:1px solid var(--warnline);color:var(--warn);
border-radius:10px;padding:14px 18px;font-size:13px;margin:24px 0}
.note b{display:block;margin-bottom:6px}
.note ul{margin:6px 0 0;padding-left:18px}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);
color:var(--muted);font-size:12px}
"""


def render(results, summaries, *, title="Backtest Report",
           benchmark_name: str | None = None, notes: list[str] | None = None) -> str:
    """Render one or more backtests into a single self-contained HTML string."""
    if not isinstance(results, (list, tuple)):
        results, summaries = [results], [summaries]

    primary, psum = results[0], summaries[0]
    dd = analytics.drawdown_detail(primary.equity)

    cards = [
        ("CAGR", _fmt_pct(psum.cagr)),
        ("Total return", _fmt_pct(psum.total_return)),
        ("Sharpe", _fmt_num(psum.sharpe)),
        ("Max drawdown", _fmt_pct(psum.max_drawdown)),
        ("Calmar", _fmt_num(psum.calmar)),
        ("Final value", _fmt_money(psum.final)),
    ]
    card_html = "".join(
        f'<div class="card"><div class="k">{k}</div><div class="v">{v}</div></div>'
        for k, v in cards
    )

    curves = {s.name: r.equity for r, s in zip(results, summaries)}

    dd_html = ""
    if dd:
        rec = f"{dd['recovery']:%Y-%m-%d}" if dd.get("recovery") is not None else "not yet recovered"
        dd_html = (
            f'<p class="sub">Worst drawdown {dd["depth"]:.2%}: peak '
            f'{dd["peak"]:%Y-%m-%d} → trough {dd["trough"]:%Y-%m-%d} '
            f'({dd["drawdown_days"]} days down), recovered {rec} '
            f'— {dd["underwater_days"]} days underwater in total.</p>'
        )

    verdict = (
        "The t-statistic clears 2, so the average daily return is statistically "
        "distinguishable from zero over this sample. That is a necessary "
        "condition for a real edge, not a sufficient one."
        if psum.significant else
        "The t-statistic is below 2: over this sample the average return is "
        "<b>not</b> statistically distinguishable from zero. Treat the CAGR "
        "above as one draw from a wide distribution, not as an expectation."
    )

    extra = "".join(f"<li>{html.escape(n)}</li>" for n in (notes or []))
    bench = f" · benchmark: {html.escape(benchmark_name)}" if benchmark_name else ""

    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title><style>{_CSS}</style></head>
<body><div class="wrap">
<h1>{html.escape(title)}</h1>
<p class="sub">{psum.start:%Y-%m-%d} → {psum.end:%Y-%m-%d} · {psum.years:.1f} years ·
initial {_fmt_money(psum.initial)}{bench} ·
generated {datetime.now():%Y-%m-%d %H:%M}</p>

<div class="cards">{card_html}</div>

<h2>Growth of 1 unit (log scale)</h2>
{_equity_chart(curves)}

<h2>Drawdown from prior peak</h2>
{_drawdown_chart(primary.equity)}
{dd_html}

<h2>Performance &amp; risk</h2>
<div class="scroll">{_summary_table(list(summaries))}</div>

<h2>Monthly returns — {html.escape(psum.name)}</h2>
<div class="scroll">{_monthly_grid(primary.equity)}</div>

<div class="note"><b>How to read this</b>
{verdict}
<ul>
<li>Costs are already deducted: {_fmt_money(psum.fees_paid)} in commission,
slippage and tax, a drag of {_fmt_pct(psum.fee_drag_annual)} per year.</li>
<li>A backtest is the best case. It has no gaps, no failed orders, no
missed rebalance because you were busy, and no temptation to override the
rule at the bottom of that {_fmt_pct(psum.max_drawdown)} drawdown.</li>
<li>Survivorship bias: if the universe was chosen because these tickers did
well, the result is partly circular.</li>
{extra}
</ul></div>

<footer>Generated by quantdesk. Research output, not investment advice.
No result here is a prediction, and past performance does not establish
future returns.</footer>
</div></body></html>"""
