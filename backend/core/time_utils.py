from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from backend.config import settings


_IST = ZoneInfo(settings.scheduler_timezone)


def now_ist() -> datetime:
    return datetime.now(_IST)
