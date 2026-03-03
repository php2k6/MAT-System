import uuid
from sqlalchemy import (
    Column, Text, VARCHAR, Boolean, Date, TIMESTAMP,
    Integer, Numeric, ForeignKey, UniqueConstraint, CheckConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from backend.database import Base


# ---------------------------------------------------------------------------
# User
# ---------------------------------------------------------------------------
class User(Base):
    __tablename__ = "users"

    user_id    = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name       = Column(Text, nullable=False)
    password   = Column(Text, nullable=False)
    email      = Column(VARCHAR(255), nullable=False, unique=True)
    created_at = Column(TIMESTAMP, server_default=func.now(), nullable=False)

    # relationships
    broker_sessions  = relationship("BrokerSession",  back_populates="user", cascade="all, delete-orphan")
    user_broker_link = relationship("UserBrokerLink", back_populates="user", uselist=False, cascade="all, delete-orphan")
    strategies       = relationship("Strategy",       back_populates="user", cascade="all, delete-orphan")


# ---------------------------------------------------------------------------
# Broker Sessions
# ---------------------------------------------------------------------------
class BrokerSession(Base):
    __tablename__ = "broker_sessions"

    id                       = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id                  = Column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)
    fyers_client_id          = Column(VARCHAR(100), nullable=False)
    access_token_encrypted   = Column(Text, nullable=False)
    refresh_token_encrypted  = Column(Text, nullable=False)
    token_date               = Column(Date, nullable=False)
    created_at               = Column(TIMESTAMP, server_default=func.now(), nullable=False)

    user = relationship("User", back_populates="broker_sessions")


# ---------------------------------------------------------------------------
# User Broker Link
# ---------------------------------------------------------------------------
class UserBrokerLink(Base):
    __tablename__ = "user_broker_link"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id         = Column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False, unique=True)
    fyers_client_id = Column(VARCHAR(100), nullable=False, unique=True)
    is_linked       = Column(Boolean, nullable=False, default=False)
    linked_at       = Column(TIMESTAMP, nullable=True)

    user = relationship("User", back_populates="user_broker_link")


# ---------------------------------------------------------------------------
# Strategies
#
#   rebalance_freq  : 1–5  (weekly, Mon–Fri)  →  is_monthly = False
#                     1–28 (day of month)      →  is_monthly = True
#   lb_period_1/2   : lookback periods in weeks
# ---------------------------------------------------------------------------
class Strategy(Base):
    __tablename__ = "strategies"

    __table_args__ = (
        CheckConstraint(
            """
            (is_monthly = FALSE AND rebalance_day BETWEEN 1 AND 5)
            OR
            (is_monthly = TRUE  AND rebalance_day BETWEEN 1 AND 28)
            """,
            name="ck_strategies_rebalance_day_range",
        ),
    )

    strat_id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id             = Column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)

    universe            = Column(Integer, nullable=False)           # e.g. Nifty50=50, Nifty250=250
    n_stocks            = Column(Integer, nullable=False)           # number of stocks to hold

    lb_period_1         = Column(Integer, nullable=False)           # lookback period 1 (weeks)
    lb_period_2         = Column(Integer, nullable=False)           # lookback period 2 (weeks)

    price_cap           = Column(Numeric(20, 8),  nullable=True)    # max stock price filter
    capital             = Column(Numeric(20, 8),  nullable=False)
    unused_capital      = Column(Numeric(20, 8),  nullable=False, default=0)
    buffer_capital      = Column(Numeric(20, 8),  nullable=False, default=0)

    rebalance_freq      = Column(Integer, nullable=False)           # period multiple (e.g. every N weeks/months)
    is_monthly          = Column(Boolean, nullable=False, default=False)
    rebalance_day       = Column(Integer, nullable=False)           # weekday 1-5 OR day-of-month 1-28

    next_rebalance_date = Column(Date, nullable=True)
    start_date          = Column(Date, nullable=False)
    market_value        = Column(Numeric(20, 8),  nullable=False, default=0)

    user      = relationship("User",      back_populates="strategies")
    portfolio = relationship("Portfolio", back_populates="strategy", cascade="all, delete-orphan")


# ---------------------------------------------------------------------------
# Portfolio  (composite PK: strat_id + date)
# ---------------------------------------------------------------------------
class Portfolio(Base):
    __tablename__ = "portfolio"

    strat_id = Column(UUID(as_uuid=True), ForeignKey("strategies.strat_id", ondelete="CASCADE"), primary_key=True)
    date     = Column(Date, primary_key=True)
    value    = Column(Numeric(20, 8), nullable=False)

    strategy = relationship("Strategy", back_populates="portfolio")


# ---------------------------------------------------------------------------
# ETF Price  (composite PK: etf_name + date)
# ---------------------------------------------------------------------------
class ETFPrice(Base):
    __tablename__ = "etf_price"

    etf_name = Column(VARCHAR(20), ForeignKey("stock_tickers.ticker", ondelete="CASCADE"), primary_key=True)
    date     = Column(Date, primary_key=True)
    close    = Column(Numeric(20, 8), nullable=False)

    stock_ticker = relationship("StockTicker", backref="etf_prices")


# ---------------------------------------------------------------------------
# Stock Tickers
# ---------------------------------------------------------------------------
class StockTicker(Base):
    __tablename__ = "stock_tickers"

    id     = Column(Integer, primary_key=True, autoincrement=True)
    ticker = Column(VARCHAR(20), nullable=False, unique=True)
    name   = Column(Text, nullable=False)
    isin   = Column(VARCHAR(20), nullable=True)
    tick   = Column(Numeric(20, 8), nullable=True)   # minimum price tick size

    prices = relationship("StockPrice", back_populates="stock_ticker", cascade="all, delete-orphan")


# ---------------------------------------------------------------------------
# Stock Price  (composite PK: ticker + date)
# ---------------------------------------------------------------------------
class StockPrice(Base):
    __tablename__ = "stock_price"

    ticker       = Column(VARCHAR(20), ForeignKey("stock_tickers.ticker", ondelete="CASCADE"), primary_key=True)
    date         = Column(Date, primary_key=True)

    open         = Column(Numeric(20, 8),  nullable=True)
    high         = Column(Numeric(20, 8),  nullable=True)
    low          = Column(Numeric(20, 8),  nullable=True)
    close        = Column(Numeric(20, 8),  nullable=False)
    volume       = Column(Numeric(25, 4),  nullable=True)

    index_member = Column(Text, nullable=True)                      # which index(es) the stock belongs to

    daily_return = Column(Numeric(38, 18), nullable=True)
    log_return   = Column(Numeric(38, 18), nullable=True)
    volatility_1y = Column(Numeric(38, 18), nullable=True)

    stock_ticker = relationship("StockTicker", back_populates="prices")
