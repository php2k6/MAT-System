from __future__ import annotations

from typing import Any

DP_CHARGE_PER_SALE_SCRIPT = 14.75


def _to_float(value: Any) -> float:
    try:
        return float(value or 0)
    except Exception:
        return 0.0


def _to_int(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def merge_holdings_positions(holdings_rows: list[Any], positions_rows: list[Any]) -> tuple[dict[str, dict], int]:
    """
    Build effective per-ticker portfolio by merging holdings + positions.

    Returns:
        merged: {
            ticker: {
                qty: int,
                avg_price: float,
                last_price: float,
            }
        }
        sale_scripts_count: number of tickers with net position sell qty (< 0)
    """
    merged: dict[str, dict] = {}
    sale_scripts: set[str] = set()

    for h in holdings_rows:
        ticker = str(getattr(h, "ticker", "") or "").upper()
        if not ticker:
            continue
        merged[ticker] = {
            "qty": _to_int(getattr(h, "qty", 0)),
            "avg_price": _to_float(getattr(h, "avg_price", 0)),
            "last_price": _to_float(getattr(h, "last_price", 0)),
        }

    for p in positions_rows:
        ticker = str(getattr(p, "ticker", "") or "").upper()
        if not ticker:
            continue

        pos_qty = _to_int(getattr(p, "qty", 0))
        pos_avg = _to_float(getattr(p, "avg_price", 0))
        pos_ltp = _to_float(getattr(p, "last_price", 0))

        if pos_qty < 0:
            sale_scripts.add(ticker)

        if ticker not in merged:
            merged[ticker] = {
                "qty": pos_qty,
                "avg_price": pos_avg,
                "last_price": pos_ltp,
            }
            continue

        old = merged[ticker]
        old_qty = _to_int(old.get("qty", 0))
        old_avg = _to_float(old.get("avg_price", 0))
        old_ltp = _to_float(old.get("last_price", 0))

        new_qty = old_qty + pos_qty

        # Keep weighted cost basis simple and deterministic.
        old_notional = old_qty * old_avg
        pos_notional = pos_qty * pos_avg
        new_notional = old_notional + pos_notional

        if new_qty != 0:
            new_avg = new_notional / new_qty
        else:
            new_avg = 0.0

        merged[ticker] = {
            "qty": new_qty,
            "avg_price": new_avg,
            "last_price": pos_ltp if pos_ltp > 0 else old_ltp,
        }

    return merged, len(sale_scripts)


def invested_from_merged(merged: dict[str, dict], sale_scripts_count: int) -> float:
    invested = 0.0
    for row in merged.values():
        qty = _to_int(row.get("qty", 0))
        if qty <= 0:
            continue
        invested += qty * _to_float(row.get("avg_price", 0))

    invested += sale_scripts_count * DP_CHARGE_PER_SALE_SCRIPT
    return invested
