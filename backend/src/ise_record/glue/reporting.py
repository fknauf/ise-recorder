from typing import Annotated

from fastapi import Depends

from ise_record.core.auth import UserInfo
from ise_record.glue.auth import get_user_info
from ise_record.glue.models import RenderRequest
from ise_record.settings import get_settings, Settings, SmtpRecipientSource


def get_recipient_address_candidates(
    render: RenderRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    user_info: Annotated[UserInfo | None, Depends(get_user_info)],
) -> list[str]:
    if settings.smtp is None:
        return []

    candidates: list[str] = []

    for source in settings.smtp.recipient:
        match source:
            case SmtpRecipientSource.REQUEST:
                if render.recipient is not None:
                    candidates.append(render.recipient)
            case SmtpRecipientSource.OIDC:
                if (
                    user_info is not None
                    and user_info.email is not None
                    and user_info.email_verified is True
                ):
                    candidates.append(user_info.email)
            case SmtpRecipientSource.OIDC_UNVERIFIED:
                if user_info is not None and user_info.email is not None:
                    candidates.append(user_info.email)

    return candidates
