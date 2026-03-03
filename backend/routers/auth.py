from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session
from pydantic import ValidationError

from backend.database import get_db
from backend.models import User, UserBrokerLink
from backend.schemas.auth import RegisterRequest, LoginRequest, UserOut
from backend.core.security import hash_password, verify_password, create_access_token
from backend.core.deps import get_current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_NAME  = "access_token"
COOKIE_MAX_AGE = 60 * 60 * 24 * 7  # 7 days in seconds


# ── GET /api/auth/me ──────────────────────────────────────────────────────────
@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    return {
        "success": True,
        "user": {
            "id":        str(current_user.user_id),
            "email":     current_user.email,
            "name":      current_user.name,
            "createdAt": current_user.created_at.isoformat(),
        },
    }


# ── POST /api/auth/logout ─────────────────────────────────────────────────────
@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME)
    return {"success": True, "message": "Logged out successfully"}


# ── POST /api/auth/register ───────────────────────────────────────────────────
@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    try:
        # check duplicate email
        existing = db.query(User).filter(User.email == body.email).first()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"success": False, "message": "Email already registered"},
            )

        user = User(
            name=body.name,
            email=body.email,
            password=hash_password(body.password),
        )
        db.add(user)
        db.commit()

        return {"success": True, "message": "Account created successfully"}

    except HTTPException:
        raise
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"success": False, "message": "Server error"},
        )


# ── POST /api/auth/login ──────────────────────────────────────────────────────
@router.post("/login")
def login(body: LoginRequest, response: Response, db: Session = Depends(get_db)):
    try:
        user = db.query(User).filter(User.email == body.email).first()

        if not user or not verify_password(body.password, user.password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"success": False, "message": "Invalid email or password"},
            )

        # check broker connection
        broker_link = (
            db.query(UserBrokerLink)
            .filter(UserBrokerLink.user_id == user.user_id)
            .first()
        )
        broker_connected = bool(broker_link and broker_link.is_linked)

        token = create_access_token(str(user.user_id))

        response.set_cookie(
            key=COOKIE_NAME,
            value=token,
            httponly=True,
            max_age=COOKIE_MAX_AGE,
            samesite="lax",
            secure=False,   # set True in production (HTTPS)
        )

        return {
            "success": True,
            "user": {
                "id":    str(user.user_id),
                "name":  user.name,
                "email": user.email,
            },
            "brokerConnected": broker_connected,
        }

    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"success": False, "message": "Server error"},
        )
