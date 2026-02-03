from fastapi import FastAPI
from backend.routers import strategies, backtest, portfolio

app = FastAPI()

app.include_router(strategies.router)
app.include_router(backtest.router)
app.include_router(portfolio.router)


@app.get("/")
def root():
    return {"message": "MAT System"}
