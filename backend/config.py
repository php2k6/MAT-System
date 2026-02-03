from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "MAT System"
    database_url: str = "sqlite:///./mat_system.db"
    
    class Config:
        env_file = ".env"


settings = Settings()
