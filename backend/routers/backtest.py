from fastapi import APIRouter

router = APIRouter(prefix="/backtest", tags=["backtest"])


@router.post("/run")
def run_backtest():
    return {}
