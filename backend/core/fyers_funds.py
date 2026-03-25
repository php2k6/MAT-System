from __future__ import annotations

from typing import Any


def _to_float(v: Any) -> float | None:
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def extract_available_cash(funds_resp: dict) -> float | None:
    if str(funds_resp.get("s", "")).lower() != "ok":
        return None

    # Prefer explicit top-level fields when available.
    for key in ("available_balance", "availableBalance", "cashAvailable", "cash_available"):
        val = _to_float(funds_resp.get(key))
        if val is not None and val >= 0:
            return val

    limits = funds_resp.get("fund_limit", []) or []
    best: tuple[int, float] | None = None

    for item in limits:
        title = str(item.get("title", "")).strip().lower()
        amount = _to_float(item.get("equityAmount"))
        if amount is None:
            amount = _to_float(item.get("val"))
        if amount is None:
            amount = _to_float(item.get("amount"))
        if amount is None:
            continue

        score = 0
        if "available balance" in title or "available_balance" in title:
            score = 100
        elif "available" in title and "balance" in title:
            score = 90
        elif "withdrawable" in title:
            score = 80
        elif "cash" in title and "available" in title:
            score = 70
        elif "balance" in title:
            score = 50

        cand = (score, amount)
        if best is None or cand[0] > best[0] or (cand[0] == best[0] and cand[1] > best[1]):
            best = cand

    if best is not None:
        return best[1]

    return None


def summarize_funds(funds_resp: dict) -> dict:
    limits = funds_resp.get("fund_limit", []) or []
    items: list[dict[str, float | str | None]] = []
    for item in limits:
        items.append(
            {
                "title": str(item.get("title", "")) or None,
                "equityAmount": _to_float(item.get("equityAmount")),
                "val": _to_float(item.get("val")),
            }
        )

    return {
        "status": funds_resp.get("s"),
        "code": funds_resp.get("code"),
        "availableCash": extract_available_cash(funds_resp),
        "items": items,
    }
