from __future__ import annotations

import contextvars
import logging
import logging.handlers
from pathlib import Path

from backend.config import settings


_request_id_ctx: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


def set_request_id(request_id: str) -> None:
    _request_id_ctx.set(request_id or "-")


def clear_request_id() -> None:
    _request_id_ctx.set("-")


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id_ctx.get()
        return True


def configure_logging() -> None:
    """Configure application-wide logging once at startup."""
    root = logging.getLogger()
    if getattr(root, "_mat_logging_configured", False):
        return

    level_name = str(settings.log_level).upper()
    level = getattr(logging, level_name, logging.INFO)
    root.setLevel(level)

    log_dir = Path(settings.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / settings.log_file_name

    fmt = (
        "%(asctime)s | %(levelname)s | %(name)s | req=%(request_id)s | "
        "%(message)s"
    )
    formatter = logging.Formatter(fmt=fmt, datefmt="%Y-%m-%d %H:%M:%S")
    req_filter = RequestIdFilter()

    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)
    console_handler.addFilter(req_filter)

    file_handler = logging.handlers.RotatingFileHandler(
        filename=log_file,
        maxBytes=int(settings.log_max_bytes),
        backupCount=int(settings.log_backup_count),
        encoding="utf-8",
    )
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)
    file_handler.addFilter(req_filter)

    root.handlers.clear()
    root.addHandler(console_handler)
    root.addHandler(file_handler)

    # Uvicorn loggers should propagate into the configured root handlers.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True

    # APScheduler executor emits noisy per-run INFO lines; keep warnings/errors only.
    logging.getLogger("apscheduler.executors.default").setLevel(logging.WARNING)

    root._mat_logging_configured = True  # type: ignore[attr-defined]
    logging.getLogger(__name__).info(
        "Logging configured level=%s file=%s", level_name, str(log_file)
    )
