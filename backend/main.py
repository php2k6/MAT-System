from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from backend.routers import strategies, portfolio, broker, live
from backend.routers import auth
from backend.database import init_db
from backend.config import settings
from backend.core.market_feed import get_market_feed_manager
from backend.scheduler import start_scheduler, stop_scheduler

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    init_db()
    if settings.enable_scheduler:
        start_scheduler()


@app.on_event("shutdown")
def on_shutdown():
    get_market_feed_manager().stop()
    if settings.enable_scheduler:
        stop_scheduler()


@app.get("/")
def root():
    return {"message": "MAT System"}
