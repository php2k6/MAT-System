from pathlib import Path
from pydantic_settings import BaseSettings

_ENV_FILE = Path(__file__).parent / ".env"


class Settings(BaseSettings):
    app_name: str = "MAT System"
    database_url: str

    # Frontend
    frontend_origin: str = "http://localhost:5173"

    # Cookie — set cookie_secure=true when backend is on HTTPS (e.g. ngrok)
    cookie_secure: bool = False

    # JWT
    jwt_secret_key: str = "changethissecretkey"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 10080  # 7 days

    # Fyers
    fyers_app_id: str = ""
    fyers_secret_key: str = ""
    fyers_redirect_uri: str = ""

    # Redis / live-price cache
    redis_url: str = ""
    redis_price_ttl_seconds: int = 900
    live_price_stale_after_seconds: int = 90
    live_price_refresh_seconds: int = 15
    fyers_quotes_chunk_size: int = 50

    # MAT engine runtime controls
    mat_cash_buffer: float = 0.005
    mat_order_wait_seconds: int = 120
    mat_order_poll_interval_seconds: int = 5
    mat_order_min_interval_seconds: float = 0.11
    mat_candidate_pool_multiplier: float = 1.5
    mat_brokerage_rate: float = 0.0
    mat_stt_sell_rate: float = 0.001
    mat_exchange_charge_rate: float = 0.0000325
    mat_sebi_charge_rate: float = 0.000001
    mat_gst_rate: float = 0.18
    mat_stamp_duty_buy_rate: float = 0.00015

    # Logging
    log_level: str = "INFO"
    log_dir: str = "logs"
    log_file_name: str = "backend.log"
    rebalance_log_file_name: str = "rebalancing.log"
    log_max_bytes: int = 5 * 1024 * 1024
    log_backup_count: int = 5

    # Operational flags
    enable_scheduler: bool = True
    enable_testing_endpoints: bool = False

    # Scheduler timing controls
    scheduler_timezone: str = "Asia/Kolkata"
    queue_rebalance_hour_ist: int = 9
    queue_rebalance_minute_ist: int = 0
    drain_rebalance_hour_ist: int = 12
    drain_rebalance_minute_ist: int = 0
    market_open_hour_ist: int = 9
    market_open_minute_ist: int = 15
    market_close_hour_ist: int = 15
    market_close_minute_ist: int = 30

    # EOD mark-to-market scheduler
    eod_mtm_hour_ist: int = 15
    eod_mtm_minute_ist: int = 40

    # Broker reconciliation snapshots (IST)
    # Runs a full holdings + cash sync from Fyers and updates strategy/portfolio.
    reconcile_open_hour_ist: int = 9
    reconcile_open_minute_ist: int = 20

    # Yahoo daily DB sync
    enable_yahoo_daily_sync: bool = False
    yahoo_daily_sync_hour_ist: int = 19
    yahoo_daily_sync_minute_ist: int = 0
    yahoo_reference_ticker: str = "NIFTYBEES.NS"
    yahoo_base_date: str = "2015-01-01"
    yahoo_split_lookback_days: int = 5
    yahoo_volatility_window: int = 252
    yahoo_annualise_vol: bool = False
    yahoo_api_delay_seconds: float = 0.2
    yahoo_fetch_retries: int = 3
    yahoo_fetch_retry_delay_seconds: float = 1.0
    yahoo_max_internal_gap_days: int = 40

    class Config:
        env_file = str(_ENV_FILE)


settings = Settings()
