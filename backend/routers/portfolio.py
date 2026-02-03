from fastapi import APIRouter

router = APIRouter(prefix="/portfolio", tags=["portfolio"])


@router.get("/{strategy_id}")
def get_portfolio():
    return {}
