from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "MAT System"
    database_url: str

    class Config:
        env_file = "backend/.env"


settings = Settings()
