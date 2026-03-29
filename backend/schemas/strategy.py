from datetime import date, timedelta

from pydantic import BaseModel, Field, field_validator, model_validator


class StrategyBase(BaseModel):
    name: str


class Strategy(StrategyBase):
    id: int
    
    class Config:
        from_attributes = True


class BacktestRequest(BaseModel):
    universe: str = Field(..., pattern="^(nifty50|nifty100|nifty150|nifty250)$")
    numStocks: int = Field(..., ge=1, le=50)
    lookback1: int = Field(..., ge=1, le=24)
    lookback2: int = Field(..., ge=1, le=36)
    priceCap: float = Field(default=1_000_000_000.0)
    capital: float = Field(..., gt=0)
    rebalanceType: str = Field(..., pattern="^(monthly|weekly)$")
    rebalanceFreq: int = Field(..., ge=1, le=52)
    backtestStartDate: str

    @field_validator("lookback1", "lookback2", "numStocks", "rebalanceFreq", mode="before")
    @classmethod
    def coerce_int(cls, v):
        return int(v) if isinstance(v, str) and v.strip() != "" else v

    @field_validator("priceCap", mode="before")
    @classmethod
    def coerce_price_cap(cls, v):
        if v is None or (isinstance(v, str) and v.strip() == ""):
            return 1_000_000_000.0
        v = float(v)
        return 1_000_000_000.0 if v <= 0 else v

    @model_validator(mode="after")
    def validate_lookbacks(self):
        if self.lookback1 == self.lookback2:
            raise ValueError("lookback1 and lookback2 must be different")
        return self


class DeployStrategyRequest(BaseModel):
    universe: str = Field(..., pattern="^(nifty50|nifty100|nifty150|nifty250)$")
    numStocks: int = Field(..., ge=1, le=50)
    lookback1: int = Field(..., ge=1, le=24)
    lookback2: int = Field(..., ge=1, le=36)
    priceCap: float | None = Field(default=None)
    capital: float = Field(..., ge=10_000)
    rebalanceType: str = Field(..., pattern="^(monthly|weekly)$")
    rebalanceFreq: int = Field(..., ge=1, le=52)
    startingDate: date

    @field_validator("lookback1", "lookback2", "numStocks", "rebalanceFreq", mode="before")
    @classmethod
    def coerce_int(cls, v):
        return int(v) if isinstance(v, str) and v.strip() != "" else v

    @field_validator("capital", mode="before")
    @classmethod
    def coerce_capital(cls, v):
        return float(v) if isinstance(v, str) and v.strip() != "" else v

    @field_validator("priceCap", mode="before")
    @classmethod
    def coerce_optional_price_cap(cls, v):
        if v is None or (isinstance(v, str) and v.strip() == ""):
            return None
        v = float(v)
        return None if v <= 0 else v

    @field_validator("startingDate")
    @classmethod
    def validate_starting_date(cls, v: date):
        if v < date.today() + timedelta(days=1):
            raise ValueError("startingDate must be at least tomorrow")
        return v

    @model_validator(mode="after")
    def validate_logic(self):
        if self.lookback1 == self.lookback2:
            raise ValueError("lookback1 and lookback2 must be different")
        if self.rebalanceType == "monthly" and self.rebalanceFreq > 12:
            raise ValueError("monthly rebalanceFreq cannot exceed 12")
        return self


class StrategyActionRequest(BaseModel):
    action: str = Field(..., pattern="^(pause|resume|stop|restart)$")


class RebalanceHistoryActionRequest(BaseModel):
    note: str | None = Field(default=None, max_length=500)
