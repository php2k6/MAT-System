import logging
import time
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from backend.routers import strategies, portfolio, broker, live
from backend.routers import auth
from backend.database import init_db
from backend.config import settings
from backend.core.logging_setup import clear_request_id, configure_logging, set_request_id
from backend.core.market_feed import get_market_feed_manager
from backend.scheduler import start_scheduler, stop_scheduler

configure_logging()
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or uuid4().hex[:12]
    set_request_id(request_id)
    started = time.perf_counter()

    logger.info("request start method=%s path=%s", request.method, request.url.path)
    try:
        response = await call_next(request)
    except Exception:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        logger.exception(
            "request error method=%s path=%s duration_ms=%.2f",
            request.method,
            request.url.path,
            duration_ms,
        )
        clear_request_id()
        raise

    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    response.headers["x-request-id"] = request_id
    logger.info(
        "request done method=%s path=%s status=%s duration_ms=%.2f",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    clear_request_id()
    return response

# Validation errors → 400 with field-specific details for frontend forms
@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    field_errors: dict[str, list[str]] = {}

    for err in exc.errors():
        loc = list(err.get("loc", []))
        msg = err.get("msg", "Invalid value")

        # Strip FastAPI transport prefixes like body/query/path.
        while loc and loc[0] in {"body", "query", "path", "header", "cookie"}:
            loc.pop(0)

        field = ".".join(str(part) for part in loc) if loc else "non_field_error"
        field_errors.setdefault(field, []).append(msg)

    first_message = next(iter(field_errors.values()))[0] if field_errors else "Invalid input data"
    logger.warning(
        "validation error path=%s message=%s fields=%s",
        request.url.path,
        first_message,
        list(field_errors.keys()),
    )

    return JSONResponse(
        status_code=400,
        content={
            "success": False,
            "message": first_message,
            "errors": field_errors,
        },
    )

app.include_router(auth.router)
app.include_router(broker.router)
app.include_router(strategies.router)
app.include_router(portfolio.router)
app.include_router(live.router)


@app.on_event("startup")
def on_startup():
    logger.info("startup begin")
    init_db()
    if settings.enable_scheduler:
        start_scheduler()
    logger.info("startup done scheduler_enabled=%s", settings.enable_scheduler)


@app.on_event("shutdown")
def on_shutdown():
    logger.info("shutdown begin")
    get_market_feed_manager().stop()
    if settings.enable_scheduler:
        stop_scheduler()
    logger.info("shutdown done")


@app.get("/")
def root():
    return {"message": "MAT System"}
