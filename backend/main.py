from fastapi import FastAPI
from backend.routers import strategies, backtest, portfolio
from backend.database import init_db

app = FastAPI()

app.include_router(strategies.router)
app.include_router(backtest.router)
app.include_router(portfolio.router)


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/")
def root():
    return {"message": "MAT System"}
