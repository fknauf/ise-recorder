"""
FastAPI dependables to do with authentication
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, UTC
import logging
from typing import Annotated, Any, NamedTuple

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import httpx2
from pydantic import ValidationError

from ise_record.core.auth import (
    OidcClient,
    ProviderUnreachable,
    Unauthenticated,
    UserInfo,
)
from ise_record.settings import get_settings, OidcSettings, Settings

logger = logging.getLogger(__name__)
security_scheme = HTTPBearer(auto_error=False)


class CachedUserInfo(NamedTuple):
    """Entry in the queried-user cache"""

    user_info: UserInfo | None
    expiry: datetime


@dataclass
class OidcServerState:
    """Oidc-specific state attached to the fastapi server"""

    client: OidcClient | None = None
    cached_users: dict[str, CachedUserInfo] = field(default_factory=dict[str, CachedUserInfo])


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
            http_timeout_seconds=oidc.http_timeout_seconds,
        )
    except httpx2.HTTPError, KeyError, ValueError, TypeError:
        logger.exception("OpenID discovery failed; authenticated endpoints will return 503")
        return None

    app_state.oidc.client = client
    logger.info("OpenID provider ready: issuer=%s", client.issuer)
    return client


async def get_oidc_client(
    request: Request, settings: Annotated[Settings, Depends(get_settings)]
) -> OidcClient | None:
    """Return the cached provider configuration, discovering it if necessary."""
    return await load_oidc_client(request.app.state, settings.oidc)


def _combine_user_infos(token_user: UserInfo, provider_user: UserInfo | None) -> UserInfo:
    if provider_user is None:
        return token_user

    sub = token_user.sub
    # assume token info is generally more recent, so prefer it over provider info.
    username = (
        token_user.preferred_username
        if isinstance(token_user.preferred_username, str)
        else provider_user.preferred_username
    )

    # but email and email_verified belong together: if the email address is changed, we can't use
    # provider's email_verified and apply it to the token email. This means that for providers that
    # allow email into the access token but not email_verified, the old email will be used for up
    # to userinfo_cache_seconds after it's changed.
    if token_user.email is not None and token_user.email_verified is not None:
        email = token_user.email
        email_verified = token_user.email_verified
    else:
        email = provider_user.email
        email_verified = provider_user.email_verified

    return UserInfo(
        sub=sub, preferred_username=username, email=email, email_verified=email_verified
    )


async def get_user_info(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    oidc_client: Annotated[OidcClient | None, Depends(get_oidc_client)],
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security_scheme)],
) -> UserInfo | None:
    """
    Get information about the logged-in user, or None if no auth is required. Throws 401 if auth is
    required but the user is not authenticated and 503 if the oidc provider was not reachable.
    """

    if not settings.auth_required:
        return None
    assert settings.oidc is not None

    if oidc_client is None:
        raise _provider_unreachable()

    if credentials is None:
        raise _unauthenticated()

    token = credentials.credentials

    try:
        claims = await oidc_client.validate_access_token(token)
        token_user = UserInfo.model_validate(claims)
    except ProviderUnreachable as exc:
        raise _provider_unreachable() from exc
    except Unauthenticated as exc:
        raise _unauthenticated() from exc
    except ValidationError as exc:
        raise _unauthenticated() from exc

    if token_user.is_complete():
        return token_user

    cached_users: dict[str, CachedUserInfo] = request.app.state.oidc.cached_users
    now = datetime.now(UTC)
    sub = token_user.sub

    cached_user = cached_users.get(sub)

    if cached_user is not None and cached_user.expiry > now:
        provider_user = cached_users[sub].user_info
    else:
        provider_user = await oidc_client.query_userinfo(token, sub)

        if provider_user is not None:
            time_to_expiry = timedelta(seconds=settings.oidc.userinfo_cache_seconds)
        else:
            provider_user = cached_user.user_info if cached_user is not None else None
            time_to_expiry = timedelta(minutes=5)

        cached_users[sub] = CachedUserInfo(
            user_info=provider_user,
            expiry=now + time_to_expiry,
        )

    return _combine_user_infos(token_user=token_user, provider_user=provider_user)
