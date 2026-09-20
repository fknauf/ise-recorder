"""
    OpenID Connect access token validation.

    The service acts as an OAuth2 resource server: an external identity provider issues
    access tokens, and this module verifies them. Provider metadata is discovered once at
    startup; signing keys are fetched and refreshed by PyJWKClient.
"""

import logging
from typing import Any, Annotated, NamedTuple

from fastapi import Depends ,HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import httpx2
import jwt
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError, PyJWTError
from pydantic import BaseModel, ValidationError

from .settings import get_settings, Settings

logger = logging.getLogger(__name__)

security_scheme = HTTPBearer(auto_error=False)

REQUIRED_CLAIMS = ("exp", "iat", "iss", "aud", "sub")
JWKS_CACHE_SECONDS = 1800.0
JWKS_REFRESH_COOLDOWN_SECONDS = 30.0

INSECURE_ALGORITHMS = frozenset({"none", "hs256", "hs384", "hs512"})

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


class OidcConfiguration(NamedTuple):
    """ Provider metadata discovered from the well-known endpoint, plus its key client """
    issuer: str
    userinfo_endpoint: str | None
    http_timeout: float
    jwk_client: jwt.PyJWKClient


async def discover_oidc_config(settings: Settings) -> OidcConfiguration:
    """ Fetch provider metadata from the well-known discovery endpoint. """
    assert settings.oidc is not None

    discovery_url = (
        f"{settings.oidc.provider_url.rstrip('/')}/.well-known/openid-configuration"
    )

    async with httpx2.AsyncClient(timeout=settings.oidc.http_timeout_seconds) as client:
        response = await client.get(discovery_url)
        response.raise_for_status()
        metadata = response.json()

    jwks_uri = metadata["jwks_uri"]
    jwk_client = jwt.PyJWKClient(
        jwks_uri,
        cache_jwk_set=True,
        lifespan=JWKS_CACHE_SECONDS,
        cooldown_duration=JWKS_REFRESH_COOLDOWN_SECONDS,
        timeout=settings.oidc.http_timeout_seconds,
    )

    return OidcConfiguration(
        issuer=metadata["issuer"],
        userinfo_endpoint=metadata.get("userinfo_endpoint"),
        http_timeout=settings.oidc.http_timeout_seconds,
        jwk_client=jwk_client,
    )


async def load_oidc_config(
        app_state: Any,
        settings: Settings
) -> OidcConfiguration | None:
    """
    Return the cached provider configuration, discovering it if necessary.

    Called once from the application lifespan so the cost and any failure are visible at
    startup. Discovery is retried on demand afterwards, so a provider that is briefly down
    while the service boots does not require a restart.
    """
    if not settings.auth_required:
        return None

    cached: OidcConfiguration | None = getattr(app_state, "oidc_config", None)
    if cached is not None:
        return cached

    try:
        # a subtlety here: Because of this await, another request could come between here and the
        # point where the oidc config is cached in app_state and do a second oidc discovery. This
        # is fine because they discover the same configuration, and also we attempt this once at
        # application start, so the race only manifests if the OIDC provider is unreachable then.
        config = await discover_oidc_config(settings)
    except (httpx2.HTTPError, KeyError, ValueError):
        logger.exception("OpenID discovery failed; authenticated endpoints will return 503")
        return None

    app_state.oidc_config = config
    logger.info("OpenID provider ready: issuer=%s", config.issuer)
    return config


def validate_access_token(
        token: str,
        oidc_config: OidcConfiguration,
        settings: Settings
) -> dict[str, Any]:
    """ Verify an access token and return its claims. """
    assert settings.oidc is not None

    try:
        signing_key = oidc_config.jwk_client.get_signing_key_from_jwt(token)
        algorithm = signing_key.algorithm_name

        if algorithm.lower() in INSECURE_ALGORITHMS:
            logger.error("key %s signs with %s, which we refuse to verify",
                         signing_key.key_id, algorithm)
            raise _unauthenticated()

        return jwt.decode(
            token,
            signing_key,
            algorithms=[algorithm],
            issuer=oidc_config.issuer,
            audience=settings.oidc.audience,
            leeway=settings.oidc.leeway_seconds,
            options={
                "require": list(REQUIRED_CLAIMS)
            },
        )
    except PyJWKClientConnectionError as exc:
        logger.error("cannot reach the JWKS endpoint: %s", exc)
        raise _provider_unreachable() from exc
    except PyJWKClientError as exc:
        logger.warning("no usable signing key for the presented token: %s", exc)
        raise _unauthenticated() from exc
    except PyJWTError as exc:
        logger.info("rejected access token: %s", exc)
        raise _unauthenticated() from exc


class UserInfo(BaseModel):
    """ Models (part of) the response of the OIDC provider's userinfo_endpoint """
    sub: str
    preferred_username: str | None = None


async def query_username(
        oidc: OidcConfiguration,
        access_token: str,
        subject: str
) -> str | None:
    """ Fallback query to oidc provider if preferred_username isn't in the access token. """

    if oidc.userinfo_endpoint is None:
        return None

    try:
        async with httpx2.AsyncClient(timeout=oidc.http_timeout) as client:
            response = await client.get(
                oidc.userinfo_endpoint,
                headers={ "Authorization": f"Bearer {access_token}" }
            )

            if response.status_code != 200:
                logger.warning("Unable to query userinfo: %s", response.text[:48])
                return None

            userinfo = UserInfo.model_validate_json(response.content)

            if userinfo.sub != subject:
                logger.warning(
                    "Discarding userinfo: endpoint returned info for %s when asked about %s",
                    userinfo.sub, subject)
                return None

            return userinfo.preferred_username
    except (httpx2.HTTPError, httpx2.InvalidURL, ValidationError) as e:
        logger.warning("Unable to query openid user info %s", e)
        return None

async def get_user_info(
        request: Request,
        settings: Annotated[Settings, Depends(get_settings)],
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security_scheme)]
) -> UserInfo | None:
    """
    Get information about the logged-in user, or None if no auth is required. Throws 401 if auth is
    required but the user is not authenticated and 503 if the oidc provider was not reachable.
    """

    if not settings.auth_required:
        return None

    oidc_config = await load_oidc_config(request.app.state, settings)
    if oidc_config is None:
        raise _provider_unreachable()

    if credentials is None:
        raise _unauthenticated()

    token = credentials.credentials
    claims = validate_access_token(token, oidc_config, settings)
    subject = claims.get("sub")

    if not isinstance(subject, str):
        raise _unauthenticated()

    cached_users: dict[str, UserInfo] | None = getattr(request.app.state, "cached_users", None)

    if cached_users is None:
        cached_users = dict[str, UserInfo]()
        request.app.state.cached_users = cached_users
    elif subject in cached_users:
        return cached_users[subject]

    username = claims.get("preferred_username")
    if not isinstance(username, str):
        username = await query_username(oidc_config, token, subject)

    user_info = UserInfo(sub=subject, preferred_username=username)
    cached_users[subject] = user_info

    return user_info
