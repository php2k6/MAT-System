from fastapi import APIRouter

router = APIRouter(prefix="/strategies", tags=["strategies"])


@router.get("/")
def list_strategies():
    return []


@router.post("/")
def create_strategy():
    return {}
