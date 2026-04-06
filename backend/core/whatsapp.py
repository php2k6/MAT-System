"""
whatsapp.py
───────────
WhatsApp notification sender via Evolution API.
Handles retries and graceful failures.
"""

import asyncio
import logging
from typing import Optional

import httpx

from backend.config import settings

logger = logging.getLogger(__name__)


async def send_whatsapp_notification(
    phone: str,
    message: str,
    title: Optional[str] = None,
    max_retries: int = 3,
) -> bool:
    """
    Send WhatsApp notification via Evolution API with automatic retry.

    Args:
        phone: recipient phone number (e.g., "+91XXXXXXXXXX")
        message: notification message text
        title: optional title (not used in message, just for logging)
        max_retries: number of retry attempts (default 3)

    Returns:
        True if sent successfully, False otherwise

    Note:
        - If EVOLUTION_API_URL is not configured, returns False silently
        - Retries with exponential backoff: 1s, 2s, 4s
        - All errors are logged but don't raise exceptions
    """
    if not phone or not settings.EVOLUTION_API_URL or not settings.EVOLUTION_API_KEY:
        logger.debug(
            "send_whatsapp_notification: skipped (missing config) phone=%s api_url=%s",
            bool(phone),
            bool(settings.EVOLUTION_API_URL),
        )
        return False

    # Normalize phone: ensure it starts with +
    if not phone.startswith("+"):
        phone = f"+{phone}"

    log_prefix = f"[WhatsApp:{phone}]"

    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                payload = {
                    "jid": f"{phone.lstrip('+')}@s.whatsapp.net",
                    "message": message,
                    "apikey": settings.EVOLUTION_API_KEY,
                }

                resp = await client.post(
                    f"{settings.EVOLUTION_API_URL}/message/sendText",
                    json=payload,
                )

                if resp.status_code in (200, 201):
                    logger.info(
                        "%s sent successfully (attempt %d/%d) title=%s",
                        log_prefix,
                        attempt + 1,
                        max_retries,
                        title or "none",
                    )
                    return True

                logger.warning(
                    "%s API returned status=%d (attempt %d/%d) response=%s",
                    log_prefix,
                    resp.status_code,
                    attempt + 1,
                    max_retries,
                    resp.text[:200],
                )

                if attempt < max_retries - 1:
                    wait_time = 2 ** attempt  # 1s, 2s, 4s
                    logger.info(
                        "%s retrying in %d seconds (attempt %d/%d)",
                        log_prefix,
                        wait_time,
                        attempt + 1,
                        max_retries,
                    )
                    await asyncio.sleep(wait_time)

        except asyncio.TimeoutError:
            logger.warning(
                "%s timeout (attempt %d/%d)",
                log_prefix,
                attempt + 1,
                max_retries,
            )
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt
                await asyncio.sleep(wait_time)

        except Exception as exc:
            logger.error(
                "%s exception: %s (attempt %d/%d)",
                log_prefix,
                exc,
                attempt + 1,
                max_retries,
            )
            if attempt < max_retries - 1:
                wait_time = 2 ** attempt
                await asyncio.sleep(wait_time)

    logger.error(
        "%s all %d retries failed (final status: message NOT sent)",
        log_prefix,
        max_retries,
    )
    return False
