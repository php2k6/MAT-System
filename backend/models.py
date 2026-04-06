import uuid
from sqlalchemy import (
    Column, Text, VARCHAR, Boolean, Date, TIMESTAMP,
    Integer, Numeric, ForeignKey, SmallInteger,
    UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from backend.database import Base


# ---------------------------------------------------------------------------
# User
# ---------------------------------------------------------------------------
class User(Base):
    __tablename__ = "users"

    user_id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name            = Column(Text, nullable=False)
    password        = Column(Text, nullable=False)
    email           = Column(VARCHAR(255), nullable=False, unique=True)
    whatsapp_number = Column(VARCHAR(20), nullable=True)  # +91XXXXXXXXXX format
    created_at      = Column(TIMESTAMP, server_default=func.now(), nullable=False)

    # relationships
    broker_sessions  = relationship("BrokerSession",  back_populates="user", cascade="all, delete-orphan")
    user_broker_link = relationship("UserBrokerLink", back_populates="user", uselist=False, cascade="all, delete-orphan")
    strategies       = relationship("Strategy",       back_populates="user", cascade="all, delete-orphan")
    rebalance_queues = relationship("RebalanceQueue",  back_populates="user", cascade="all, delete-orphan")
    rebalancing_history = relationship("RebalancingHistory", back_populates="user", cascade="all, delete-orphan")


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
#   rebalance_freq  : N months (is_monthly=True) or N weeks (is_monthly=False)
#   lb_period_1/2   : lookback periods in months
#   status          : "active" | "paused" | "stopped"
#   next_rebalance_date starts as start_date; advanced on each queue insertion
# ---------------------------------------------------------------------------
class Strategy(Base):
    __tablename__ = "strategies"

    strat_id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id             = Column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)

    universe            = Column(Integer, nullable=False)           # e.g. 50, 100, 150, 250
    n_stocks            = Column(Integer, nullable=False)

    lb_period_1         = Column(Integer, nullable=False)           # lookback 1 in months
    lb_period_2         = Column(Integer, nullable=False)           # lookback 2 in months

    price_cap           = Column(Numeric(20, 8),  nullable=True)
    capital             = Column(Numeric(20, 8),  nullable=False)
    unused_capital      = Column(Numeric(20, 8),  nullable=False, default=0)
    buffer_capital      = Column(Numeric(20, 8),  nullable=False, default=0)

    rebalance_freq      = Column(Integer, nullable=False)           # N months or N weeks
    is_monthly          = Column(Boolean, nullable=False, default=False)

    next_rebalance_date = Column(Date, nullable=True)
    start_date          = Column(Date, nullable=False)
    market_value        = Column(Numeric(20, 8),  nullable=False, default=0)

    # "active" | "paused" | "stopped"
    status              = Column(VARCHAR(20), nullable=False, default="stopped")

    user              = relationship("User",           back_populates="strategies")
    portfolio         = relationship("Portfolio",      back_populates="strategy",        cascade="all, delete-orphan")
    holdings          = relationship("Holdings",       back_populates="strategy",        cascade="all, delete-orphan")
    positions         = relationship("Positions", back_populates="strategy",      cascade="all, delete-orphan")
    rebalance_history = relationship("RebalanceQueue", back_populates="strategy",        cascade="all, delete-orphan", order_by="RebalanceQueue.queued_at.desc()")
    rebalancing_runs  = relationship("RebalancingHistory", back_populates="strategy", cascade="all, delete-orphan", order_by="RebalancingHistory.started_at.desc()")


# ---------------------------------------------------------------------------
# Holdings  (what the strategy currently owns — synced after each rebalance)
# ---------------------------------------------------------------------------
class Holdings(Base):
    __tablename__ = "holdings"

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strat_id    = Column(UUID(as_uuid=True), ForeignKey("strategies.strat_id", ondelete="CASCADE"), nullable=False)
    ticker      = Column(VARCHAR(20), nullable=False)         # e.g. "INFY"
    qty         = Column(Integer,     nullable=False)
    avg_price   = Column(Numeric(20, 8), nullable=True)       # average acquisition price
    last_price  = Column(Numeric(20, 8), nullable=True)       # LTP at last rebalance
    updated_at  = Column(TIMESTAMP, server_default=func.now(), nullable=False)

    strategy = relationship("Strategy", back_populates="holdings")

    __table_args__ = (
        UniqueConstraint("strat_id", "ticker", name="uq_holdings_strat_ticker"),
    )


# ---------------------------------------------------------------------------
# Strategy Positions (separate from holdings; mirrors broker positions view)
# ---------------------------------------------------------------------------
class Positions(Base):
    __tablename__ = "positions"

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strat_id    = Column(UUID(as_uuid=True), ForeignKey("strategies.strat_id", ondelete="CASCADE"), nullable=False)
    ticker      = Column(VARCHAR(20), nullable=False)
    qty         = Column(Integer, nullable=False)
    avg_price   = Column(Numeric(20, 8), nullable=True)
    last_price  = Column(Numeric(20, 8), nullable=True)
    updated_at  = Column(TIMESTAMP, server_default=func.now(), nullable=False)

    strategy = relationship("Strategy", back_populates="positions")

    __table_args__ = (
        UniqueConstraint("strat_id", "ticker", name="uq_positions_strat_ticker"),
    )


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
# Rebalance Queue
#
#   One row per strategy pending rebalance (UNIQUE on strat_id).
#   status : "pending"    → waiting to be picked up by the execution scheduler
#            "in_progress" → MATEngine is running right now
#            "done"        → completed successfully (row cleaned up after)
#            "failed"      → unrecoverable error; needs manual review
#            "skipped"     → LC detected / market closed; will retry next run
# ---------------------------------------------------------------------------
class RebalanceQueue(Base):
    __tablename__ = "rebalance_queue"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strat_id     = Column(UUID(as_uuid=True), ForeignKey("strategies.strat_id", ondelete="CASCADE"), nullable=False)
    user_id      = Column(UUID(as_uuid=True), ForeignKey("users.user_id",       ondelete="CASCADE"), nullable=False)

    status       = Column(VARCHAR(20),  nullable=False, default="pending")  # pending | in_progress | done | failed | skipped
    reason       = Column(Text,         nullable=True)                       # e.g. "LC_DETECTED", "MARKET_CLOSED"
    retry_count               = Column(SmallInteger, nullable=False, default=0)
    last_notification_sent_at = Column(TIMESTAMP, nullable=True)

    queued_at    = Column(TIMESTAMP, nullable=False, server_default=func.now())
    attempted_at = Column(TIMESTAMP, nullable=True)
    completed_at = Column(TIMESTAMP, nullable=True)

    strategy = relationship("Strategy",       back_populates="rebalance_history")
    user     = relationship("User",           back_populates="rebalance_queues")
    history_runs = relationship("RebalancingHistory", back_populates="queue_entry", cascade="all, delete-orphan")


# ---------------------------------------------------------------------------
# Rebalancing History (one row per rebalance execution attempt)
# ---------------------------------------------------------------------------
class RebalancingHistory(Base):
    __tablename__ = "rebalancing_history"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    strat_id      = Column(UUID(as_uuid=True), ForeignKey("strategies.strat_id", ondelete="CASCADE"), nullable=False)
    queue_id      = Column(UUID(as_uuid=True), ForeignKey("rebalance_queue.id", ondelete="SET NULL"), nullable=True)
    user_id       = Column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)
    status        = Column(VARCHAR(20), nullable=False, default="failed")
    reason        = Column(Text, nullable=True)

    started_at    = Column(TIMESTAMP, nullable=False, server_default=func.now())
    completed_at  = Column(TIMESTAMP, nullable=True)

    pre_cash      = Column(Numeric(20, 8), nullable=True)
    post_cash     = Column(Numeric(20, 8), nullable=True)
    pre_total     = Column(Numeric(20, 8), nullable=True)
    post_total    = Column(Numeric(20, 8), nullable=True)

    pre_holdings_json   = Column(Text, nullable=True)
    post_holdings_json  = Column(Text, nullable=True)
    orders_json         = Column(Text, nullable=True)
    summary_json        = Column(Text, nullable=True)

    strategy   = relationship("Strategy", back_populates="rebalancing_runs")
    queue_entry = relationship("RebalanceQueue", back_populates="history_runs")
    user       = relationship("User", back_populates="rebalancing_history")
    order_legs = relationship("RebalanceOrderLeg", back_populates="history", cascade="all, delete-orphan")


# ---------------------------------------------------------------------------
# Rebalance Order Legs (one row per intended execution leg)
# ---------------------------------------------------------------------------
class RebalanceOrderLeg(Base):
    __tablename__ = "rebalance_order_legs"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    history_id      = Column(UUID(as_uuid=True), ForeignKey("rebalancing_history.id", ondelete="CASCADE"), nullable=False)
    strat_id        = Column(UUID(as_uuid=True), ForeignKey("strategies.strat_id", ondelete="CASCADE"), nullable=False)
    user_id         = Column(UUID(as_uuid=True), ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)

    phase           = Column(VARCHAR(10), nullable=False)   # sell | buy
    side            = Column(VARCHAR(4), nullable=False)    # SELL | BUY
    symbol          = Column(VARCHAR(20), nullable=False)

    requested_qty   = Column(Integer, nullable=False)
    filled_qty      = Column(Integer, nullable=False, default=0)
    remaining_qty   = Column(Integer, nullable=False, default=0)

    status          = Column(VARCHAR(24), nullable=False, default="planned")
    broker_order_id = Column(VARCHAR(80), nullable=True)
    attempt_no      = Column(SmallInteger, nullable=False, default=1)

    error_code      = Column(VARCHAR(64), nullable=True)
    error_message   = Column(Text, nullable=True)
    is_retryable    = Column(Boolean, nullable=False, default=True)

    created_at      = Column(TIMESTAMP, server_default=func.now(), nullable=False)
    updated_at      = Column(TIMESTAMP, server_default=func.now(), onupdate=func.now(), nullable=False)

    history         = relationship("RebalancingHistory", back_populates="order_legs")


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
