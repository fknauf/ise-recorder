"""
FastAPI dependables to do with report sending
"""
import logging
from typing import Annotated

from fastapi import Depends

from ise_record.core.auth import UserInfo
from ise_record.core.reporting import normalize_recipient
from ise_record.glue.auth import get_user_info
from ise_record.glue.models import RenderRequest
from ise_record.settings import get_settings, Settings, SmtpRecipientSource

logger = logging.getLogger(__name__)


def _normalized_recipient_address(
    source: SmtpRecipientSource,
    render: RenderRequest,
    user_info: UserInfo | None,
    allowed_domains: tuple[str, ...],
) -> str | None:
    match source:
        case SmtpRecipientSource.REQUEST:
            raw_address = render.recipient
        case SmtpRecipientSource.OIDC:
            if user_info is None:
                return None

            if user_info.email_verified is not True:
                logger.debug("Skipping unverified recipient address %s", user_info.email)
                return None

            raw_address = user_info.email
        case SmtpRecipientSource.OIDC_UNVERIFIED:
            if user_info is None:
                return None

            raw_address = user_info.email

    return normalize_recipient(raw_address, allowed_domains)


def get_report_recipient(
    render: RenderRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    user_info: Annotated[UserInfo | None, Depends(get_user_info)],
) -> str | None:
    """FastAPI dependable to retrieve the report recipient address for a postprocessing job"""
    if settings.smtp is None:
        return None

    for source in settings.smtp.recipient_sources:
        recipient = _normalized_recipient_address(
            source, render, user_info, settings.smtp.allowed_domains
        )
        if recipient is not None:
            return recipient

    return None
