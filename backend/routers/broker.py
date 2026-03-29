from datetime import date, datetime
from uuid import UUID
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from fyers_apiv3 import fyersModel
from sqlalchemy.orm import Session

from backend.core.deps import get_current_user
from backend.core.fyers_funds import extract_available_cash, summarize_funds
from backend.core.market_feed import get_market_feed_manager
from backend.core.security import decrypt_token, encrypt_token
from backend.core.time_utils import now_ist
from backend.database import get_db
from backend.models import BrokerSession, StockTicker, User, UserBrokerLink
from backend.config import settings

router = APIRouter(prefix="/api/broker", tags=["broker"])
logger = logging.getLogger(__name__)


def _ensure_testing_enabled() -> None:
    if not settings.enable_testing_endpoints:
        raise HTTPException(status_code=404, detail="Not found")


# ── POST /api/broker/connect ──────────────────────────────────────────────────
@router.post("/connect")
def connect_broker(current_user: User = Depends(get_current_user)):
    """
    Generates a Fyers OAuth login URL and returns it to the frontend.
    The frontend redirects the user to this URL.
    state = user_id so the callback endpoint knows which user authenticated.
    """
    if not settings.fyers_app_id or not settings.fyers_secret_key or not settings.fyers_redirect_uri:
        logger.warning("broker.connect not_configured user_id=%s", current_user.user_id)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"success": False, "message": "Broker integration not configured"},
        )

    try:
        logger.info("broker.connect start user_id=%s", current_user.user_id)
        session = fyersModel.SessionModel(
            client_id=settings.fyers_app_id,
            secret_key=settings.fyers_secret_key,
            redirect_uri=settings.fyers_redirect_uri,
            response_type="code",
            state=str(current_user.user_id),
            grant_type="authorization_code",
        )
        url = session.generate_authcode()
        logger.info("broker.connect success user_id=%s", current_user.user_id)
        return {"success": True, "redirectUrl": url}

    except Exception:
        logger.exception("broker.connect failed user_id=%s", current_user.user_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"success": False, "message": "Failed to generate broker login URL"},
        )


# ── GET /api/broker/status ────────────────────────────────────────────────────
@router.get("/status")
def broker_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    logger.info("broker.status start user_id=%s", current_user.user_id)
    """
    Returns whether the current user has a valid active broker session.
    If the token is from the previous day, attempts a silent refresh via
    the Fyers refresh token before declaring the session expired.
    """
    session = (
        db.query(BrokerSession)
        .filter(BrokerSession.user_id == current_user.user_id)
        .order_by(BrokerSession.created_at.desc())
        .first()
    )

    if not session:
        logger.info("broker.status no_session user_id=%s", current_user.user_id)
        return {"success": True, "brokerConnected": False, "reason": "NO_SESSION"}

    today = date.today()

    # Fyers tokens are valid for the current trading day only — no refresh supported
    if session.token_date == today:
        logger.info("broker.status connected user_id=%s", current_user.user_id)
        return {"success": True, "brokerConnected": True}

    logger.info("broker.status token_expired user_id=%s", current_user.user_id)
    return {"success": True, "brokerConnected": False, "reason": "TOKEN_EXPIRED"}


@router.get("/testing/fyers-health")
def testing_fyers_health(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Read-only Fyers connectivity check for local testing:
    - validates today's broker session
    - calls profile, funds, holdings, positions
    - returns compact health summary
    """
    _ensure_testing_enabled()

    logger.info("broker.testing.fyers_health start user_id=%s", current_user.user_id)

    session = (
        db.query(BrokerSession)
        .filter(
            BrokerSession.user_id == current_user.user_id,
            BrokerSession.token_date == date.today(),
        )
        .order_by(BrokerSession.created_at.desc())
        .first()
    )
    if not session:
        logger.warning("broker.testing.fyers_health no_session user_id=%s", current_user.user_id)
        return {
            "success": False,
            "connected": False,
            "message": "No active Fyers session for today",
            "checks": {},
        }

    try:
        token = decrypt_token(session.access_token_encrypted)
        fyers = fyersModel.FyersModel(
            client_id=settings.fyers_app_id,
            token=token,
            is_async=False,
            log_path=settings.log_dir,
        )

        profile_resp = fyers.get_profile()
        funds_resp = fyers.funds()
        holdings_resp = fyers.holdings()
        positions_resp = fyers.positions()

        def _ok(resp: dict) -> bool:
            return str(resp.get("s", "")).lower() == "ok"

        checks = {
            "profile": {
                "ok": _ok(profile_resp),
                "status": profile_resp.get("s"),
                "code": profile_resp.get("code"),
            },
            "funds": {
                "ok": _ok(funds_resp),
                "status": funds_resp.get("s"),
                "code": funds_resp.get("code"),
                "fundItems": len(funds_resp.get("fund_limit", []) or []),
                "availableCash": extract_available_cash(funds_resp),
            },
            "holdings": {
                "ok": _ok(holdings_resp),
                "status": holdings_resp.get("s"),
                "code": holdings_resp.get("code"),
                "count": len(holdings_resp.get("holdings", []) or []),
            },
            "positions": {
                "ok": _ok(positions_resp),
                "status": positions_resp.get("s"),
                "code": positions_resp.get("code"),
                "netCount": len(positions_resp.get("netPositions", []) or []),
            },
        }

        connected = all(v["ok"] for v in checks.values())
        logger.info(
            "broker.testing.fyers_health done user_id=%s connected=%s",
            current_user.user_id,
            connected,
        )
        return {
            "success": connected,
            "connected": connected,
            "sessionDate": session.token_date.isoformat(),
            "checkedAt": now_ist().isoformat(),
            "checks": checks,
            "details": {
                "funds": summarize_funds(funds_resp),
                "holdings": {
                    "count": len(holdings_resp.get("holdings", []) or []),
                    "items": [
                        {
                            "symbol": row.get("symbol") or row.get("nseSymbol") or row.get("isin"),
                            "qty": row.get("quantity", row.get("qty")),
                            "ltp": row.get("ltp"),
                            "marketVal": row.get("marketVal", row.get("market_value")),
                            "costPrice": row.get("costPrice", row.get("avg_price")),
                        }
                        for row in (holdings_resp.get("holdings", []) or [])[:25]
                    ],
                },
                "positions": {
                    "count": len(positions_resp.get("netPositions", []) or []),
                    "items": [
                        {
                            "symbol": row.get("symbol"),
                            "qty": row.get("netQty", row.get("qty")),
                            "avg": row.get("netAvg", row.get("avgPrice")),
                            "ltp": row.get("ltp"),
                            "pnl": row.get("pl", row.get("pnl")),
                            "marketVal": row.get("marketVal"),
                        }
                        for row in (positions_resp.get("netPositions", []) or [])[:25]
                    ],
                },
            },
        }
    except Exception as exc:
        logger.exception("broker.testing.fyers_health failed user_id=%s", current_user.user_id)
        return {
            "success": False,
            "connected": False,
            "message": f"Fyers health check failed: {exc}",
            "checks": {},
        }


# ── GET /api/broker/callback ──────────────────────────────────────────────────
@router.get("/callback")
def broker_callback(
    s: str = Query(...),           # Fyers status: "ok" or "error"
    auth_code: str = Query(...),   # one-time authorization code from Fyers
    state: str = Query(...),       # user_id we passed in connect step
    db: Session = Depends(get_db),
):
    """
    Fyers redirects here after the user logs in.
    Exchanges auth_code for access + refresh tokens, stores them encrypted in DB.
    """
    _err_redirect = f"{settings.frontend_origin}/dashboard"

    # Fyers signals a failed login
    if s != "ok":
        logger.warning("broker.callback auth_failed status=%s", s)
        return RedirectResponse(f"{_err_redirect}?status=error&reason=auth_failed")

    # Validate state is a valid UUID (user_id)
    try:
        user_id = UUID(state)
    except ValueError:
        logger.warning("broker.callback invalid_state state=%s", state)
        return RedirectResponse(f"{_err_redirect}?status=error&reason=invalid_state")

    # Confirm user exists
    user = db.query(User).filter(User.user_id == user_id).first()
    if not user:
        logger.warning("broker.callback user_not_found user_id=%s", user_id)
        return RedirectResponse(f"{_err_redirect}?status=error&reason=user_not_found")

    # Exchange auth_code for tokens
    try:
        session = fyersModel.SessionModel(
            client_id=settings.fyers_app_id,
            secret_key=settings.fyers_secret_key,
            redirect_uri=settings.fyers_redirect_uri,
            response_type="code",
            grant_type="authorization_code",
        )
        session.set_token(auth_code)
        response = session.generate_token()
    except Exception:
        logger.exception("broker.callback fyers_unreachable user_id=%s", user_id)
        return RedirectResponse(f"{_err_redirect}?status=error&reason=fyers_unreachable")

    if response.get("s") != "ok":
        logger.warning("broker.callback token_exchange_failed user_id=%s resp=%s", user_id, response)
        return RedirectResponse(f"{_err_redirect}?status=error&reason=token_exchange_failed")

    access_token  = response.get("access_token", "")
    refresh_token = response.get("refresh_token", "")
    if not access_token:
        logger.warning("broker.callback token_missing user_id=%s", user_id)
        return RedirectResponse(f"{_err_redirect}?status=error&reason=token_missing")
    today         = date.today()

    try:
        # Remove any existing session for this user (only one active session per user)
        db.query(BrokerSession).filter(BrokerSession.user_id == user_id).delete()

        # Store new session
        broker_session = BrokerSession(
            user_id=user_id,
            fyers_client_id=settings.fyers_app_id,
            access_token_encrypted=encrypt_token(access_token),
            refresh_token_encrypted=encrypt_token(refresh_token) if refresh_token else encrypt_token(""),
            token_date=today,
        )
        db.add(broker_session)

        # Upsert UserBrokerLink
        link = db.query(UserBrokerLink).filter(UserBrokerLink.user_id == user_id).first()
        if link:
            link.is_linked  = True
            link.linked_at  = now_ist()
        else:
            db.add(UserBrokerLink(
                user_id=user_id,
                fyers_client_id=settings.fyers_app_id,
                is_linked=True,
                linked_at=now_ist(),
            ))

        db.commit()
    except Exception:
        db.rollback()
        logger.exception("broker.callback db_error user_id=%s", user_id)
        return RedirectResponse(f"{_err_redirect}?status=error&reason=db_error")

    # Ensure backend market feed is running after successful broker connection.
    try:
        tickers = [r.ticker for r in db.query(StockTicker.ticker).all()]
        started = get_market_feed_manager().ensure_running(access_token=access_token, symbols=tickers)
        if started:
            logger.info("broker_callback: started market feed websocket")
    except Exception as exc:
        # Keep callback success even if feed startup fails; scheduler polling remains fallback.
        logger.warning("broker_callback: market feed startup failed: %s", exc)

    # Reconcile broker snapshot immediately after callback so holdings/positions
    # are fresh without waiting for the next scheduled reconcile window.
    try:
        from backend.scheduler import broker_reconcile_snapshot

        result = broker_reconcile_snapshot()
        logger.info("broker_callback: broker_reconcile_snapshot result=%s", result)
    except Exception as exc:
        logger.warning("broker_callback: immediate broker reconcile failed: %s", exc)

    return RedirectResponse(f"{settings.frontend_origin}/dashboard?status=connected")
