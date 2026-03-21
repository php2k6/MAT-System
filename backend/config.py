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

    class Config:
        env_file = str(_ENV_FILE)


settings = Settings()
