"""
FastAPI dependables to do with authentication
"""

from dataclasses import dataclass, field
import logging
from typing import Any, Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import httpx2

from ise_record.settings import OidcSettings, Settings, get_settings
from ise_record.core.auth import (
    DownloadTotpAuthority,
    OidcClient,
    ProviderUnreachable,
    Unauthenticated,
    UserInfo
)


logger = logging.getLogger(__name__)
security_scheme = HTTPBearer(auto_error=False)


@dataclass
class OidcServerState:
    """ Oidc-specific state attached to the fastapi server """

    client: OidcClient | None = None
    cached_users: dict[str, UserInfo] = field(default_factory=dict[str, UserInfo])


def _unauthenticated():
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _provider_unreachable():
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Unable to contact the OpenID provider",
    )


async def load_oidc_client(
        app_state: Any,
        oidc: OidcSettings | None,
) -> OidcClient | None:
    """
    Attempt to load the oidc client into the application state. Done once at application start,
    and if that fails again at request time until it worked once.
    """
    if oidc is None:
        return None

    cached: OidcClient | None = app_state.oidc.client
    if cached is not None:
        return cached

    try:
        # a subtlety here: Because of this await, another request could come between here and the
        # point where the oidc config is cached in app_state and do a second oidc discovery. This
        # is fine because they discover the same configuration, and also we attempt this once at
        # application start, so the race only manifests if the OIDC provider is unreachable then.
        client = await OidcClient.discover(
            provider_url=oidc.provider_url,
            audience=oidc.audience,
            leeway_seconds=oidc.leeway_seconds,
            http_timeout_seconds=oidc.http_timeout_seconds
        )
    except (httpx2.HTTPError, KeyError, ValueError):
        logger.exception("OpenID discovery failed; authenticated endpoints will return 503")
        return None

    app_state.oidc.client = client
    logger.info("OpenID provider ready: issuer=%s", client.issuer)
    return client


async def get_oidc_client(
        request: Request,
        settings: Annotated[Settings, Depends(get_settings)]
) -> OidcClient | None:
    """
    Return the cached provider configuration, discovering it if necessary.

    Called once from the application lifespan so the cost and any failure are visible at
    startup. Discovery is retried on demand afterwards, so a provider that is briefly down
    while the service boots does not require a restart.
    """
    return await load_oidc_client(request.app.state, settings.oidc)


async def get_user_info(
        request: Request,
        settings: Annotated[Settings, Depends(get_settings)],
        oidc_client: Annotated[OidcClient | None, Depends(get_oidc_client)],
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security_scheme)]
) -> UserInfo | None:
    """
    Get information about the logged-in user, or None if no auth is required. Throws 401 if auth is
    required but the user is not authenticated and 503 if the oidc provider was not reachable.
    """

    if not settings.auth_required:
        return None

    if oidc_client is None:
        raise _provider_unreachable()

    if credentials is None:
        raise _unauthenticated()

    token = credentials.credentials

    try:
        claims = oidc_client.validate_access_token(token)
    except ProviderUnreachable as exc:
        raise _provider_unreachable() from exc
    except Unauthenticated as exc:
        raise _unauthenticated() from exc

    subject = claims.get("sub")
    if not isinstance(subject, str):
        raise _unauthenticated()

    cached_users: dict[str, UserInfo] = request.app.state.oidc.cached_users

    if subject in cached_users:
        return cached_users[subject]

    username = claims.get("preferred_username")
    if not isinstance(username, str):
        username = await oidc_client.query_username(token, subject)

    user_info = UserInfo(sub=subject, preferred_username=username)
    cached_users[subject] = user_info

    return user_info


async def get_download_totp(request: Request) -> DownloadTotpAuthority:
    """ FastAPI dependable to obtain the TOTP authority """
    return request.app.state.download_totp
