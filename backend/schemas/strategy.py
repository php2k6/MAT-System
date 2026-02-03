from pydantic import BaseModel


class StrategyBase(BaseModel):
    name: str


class Strategy(StrategyBase):
    id: int
    
    class Config:
        from_attributes = True
