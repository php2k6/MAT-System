from fastapi import Cookie, HTTPException, status, Depends
from sqlalchemy.orm import Session
from typing import Optional

from backend.core.security import decode_access_token
from backend.database import get_db
from backend.models import User


def get_current_user(
    access_token: Optional[str] = Cookie(default=None),
    db: Session = Depends(get_db),
) -> User:
    """
    Reads JWT from the 'access_token' HttpOnly cookie.
    Raises 401 if missing, invalid, or user not found.
    """
    if not access_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
        )

    user_id = decode_access_token(access_token)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
        )

    user = db.query(User).filter(User.user_id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
        )
    return user
