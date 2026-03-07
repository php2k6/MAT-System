from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from backend.routers import strategies, backtest, portfolio, broker
from backend.routers import auth
from backend.database import init_db
from backend.config import settings

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Validation errors → 400 with consistent shape
@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=400,
        content={"success": False, "message": "Invalid input data"},
    )

app.include_router(auth.router)
app.include_router(broker.router)
app.include_router(strategies.router)
app.include_router(backtest.router)
app.include_router(portfolio.router)


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/")
def root():
    return {"message": "MAT System"}
