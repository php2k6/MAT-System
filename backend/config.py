from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "MAT System"
    database_url: str

    # JWT
    jwt_secret_key: str = "changethissecretkey"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 10080  # 7 days

    class Config:
        env_file = "backend/.env"


settings = Settings()
