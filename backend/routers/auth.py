import logging

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session
from pydantic import ValidationError

from backend.database import get_db
from backend.models import User, UserBrokerLink
from backend.schemas.auth import RegisterRequest, LoginRequest, UserOut, ChangePasswordRequest
from backend.core.security import hash_password, verify_password, create_access_token
from backend.core.deps import get_current_user
from backend.config import settings

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger(__name__)

COOKIE_NAME  = "access_token"
COOKIE_MAX_AGE = 60 * 60 * 24 * 7  # 7 days in seconds


# ── GET /api/auth/me ──────────────────────────────────────────────────────────
@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    logger.info("auth.me success user_id=%s", current_user.user_id)
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
    logger.info("auth.logout")
    response.delete_cookie(COOKIE_NAME)
    return {"success": True, "message": "Logged out successfully"}


# ── POST /api/auth/register ───────────────────────────────────────────────────
@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    logger.info("auth.register attempt email=%s", body.email)
    try:
        # check duplicate email
        existing = db.query(User).filter(User.email == body.email).first()
        if existing:
            logger.warning("auth.register duplicate email=%s", body.email)
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
        logger.info("auth.register success email=%s", body.email)

        return {"success": True, "message": "Account created successfully"}

    except HTTPException:
        raise
    except Exception:
        db.rollback()
        logger.exception("auth.register server error email=%s", body.email)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"success": False, "message": "Server error"},
        )


# ── POST /api/auth/login ──────────────────────────────────────────────────────
@router.post("/login")
def login(body: LoginRequest, response: Response, db: Session = Depends(get_db)):
    logger.info("auth.login attempt email=%s", body.email)
    try:
        user = db.query(User).filter(User.email == body.email).first()

        if not user or not verify_password(body.password, user.password):
            logger.warning("auth.login invalid credentials email=%s", body.email)
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
            samesite="none" if settings.cookie_secure else "lax",
            secure=settings.cookie_secure,
        )

        logger.info("auth.login success user_id=%s broker_connected=%s", user.user_id, broker_connected)

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
        logger.exception("auth.login server error email=%s", body.email)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"success": False, "message": "Server error"},
        )


# ── POST /api/auth/change-password ────────────────────────────────────────────
@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    logger.info("auth.change_password attempt user_id=%s", current_user.user_id)
    try:
        if not verify_password(body.currentPassword, current_user.password):
            logger.warning("auth.change_password invalid current password user_id=%s", current_user.user_id)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"success": False, "message": "Incorrect current password"},
            )

        current_user.password = hash_password(body.newPassword)
        db.commit()
        logger.info("auth.change_password success user_id=%s", current_user.user_id)

        return {"success": True, "message": "Password updated successfully"}

    except HTTPException:
        raise
    except Exception:
        db.rollback()
        logger.exception("auth.change_password server error user_id=%s", current_user.user_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"success": False, "message": "Server error"},
        )
