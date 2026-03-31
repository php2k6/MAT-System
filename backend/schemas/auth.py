from pydantic import BaseModel, EmailStr
from datetime import datetime
from uuid import UUID


class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: UUID
    name: str
    email: str
    createdAt: datetime

    model_config = {"from_attributes": True}


class ChangePasswordRequest(BaseModel):
    currentPassword: str
    newPassword: str
