import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from backend.backtest_engine import build_series, build_stats, run_backtest
from backend.database import get_db
from backend.models import StockPrice

router = APIRouter(prefix="/api/strategy", tags=["strategy"])


class BacktestRequest(BaseModel):
    universe:           str   = Field(..., pattern="^(nifty50|nifty100|nifty150|nifty250)$")
    numStocks:          int   = Field(..., ge=1, le=50)
    lookback1:          int   = Field(..., ge=1, le=24)
    lookback2:          int   = Field(..., ge=1, le=36)
    priceCap:           float = Field(default=1_000_000_000.0)
    capital:            float = Field(..., gt=0)
    rebalanceType:      str   = Field(..., pattern="^(monthly|weekly)$")
    rebalanceFreq:      int   = Field(..., ge=1, le=52)
    backtestStartDate:  str                        # YYYY-MM-DD anchor for rebalance schedule
    startingDate:       str                        # filler — strategy deployment start date

    @field_validator("lookback1", "lookback2", "numStocks", "rebalanceFreq", mode="before")
    @classmethod
    def coerce_int(cls, v):
        return int(v) if isinstance(v, str) and v.strip() != "" else v

    @field_validator("priceCap", mode="before")
    @classmethod
    def coerce_price_cap(cls, v):
        if v is None or (isinstance(v, str) and v.strip() == ""):
            return 1_000_000_000.0
        return float(v)
    

@router.post("/backtest")
def run_backtest_api(req: BacktestRequest, db: Session = Depends(get_db)):
    # Pull required columns from stock_price; alias ticker → symbol
    rows = db.query(
        StockPrice.ticker,
        StockPrice.date,
        StockPrice.close,
        StockPrice.volatility_1y,
        StockPrice.index_member,
    ).all()

    if not rows:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"success": False, "message": "No stock price data in database"},
        )

    df = pd.DataFrame(rows, columns=["symbol", "date", "close", "volatility_1y", "index_member"])
    df["date"]          = pd.to_datetime(df["date"])
    df["close"]         = df["close"].astype(float)
    df["volatility_1y"] = df["volatility_1y"].astype(float)

    try:
        result, _, _ = run_backtest(
            df,
            universe=req.universe,
            n_stocks=req.numStocks,
            lookback_1=req.lookback1,
            lookback_2=req.lookback2,
            min_price=1.0,
            max_price=req.priceCap,
            initial_capital=req.capital,
            rebalance_type=req.rebalanceType,
            rebalance_freq=req.rebalanceFreq,
            starting_date=req.backtestStartDate,
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"success": False, "message": str(e)},
        )

    # Trim output to startingDate — simulation runs from full history for
    # momentum warm-up, but series and stats are reported from startingDate onward
    result_trimmed = result[result.index >= pd.Timestamp(req.backtestStartDate)]

    return {
        "success": True,
        "stats":   build_stats(result_trimmed, req.universe, req.capital),
        "series":  build_series(result_trimmed),
    }
