"""
    OpenID Connect access token validation.

    The service acts as an OAuth2 resource server: an external identity provider issues
    access tokens, and this module verifies them. Provider metadata is discovered once at
    startup; signing keys are fetched and refreshed by PyJWKClient.
"""

import hashlib
import logging
import re
from typing import Annotated, Any, NamedTuple, Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import httpx2
import jwt
from jwt.exceptions import PyJWKClientConnectionError, PyJWKClientError, PyJWTError

from .settings import get_settings, SAFE_NAME_REGEX, Settings

logger = logging.getLogger(__name__)

security_scheme = HTTPBearer(auto_error=False)

ANONYMOUS_HOME = "."
REQUIRED_CLAIMS = ("exp", "iat", "iss", "aud", "sub", "scope")
JWKS_CACHE_SECONDS = 1800.0

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
        timeout=settings.oidc.http_timeout_seconds,
    )

    return OidcConfiguration(
        issuer=metadata["issuer"],
        jwk_client=jwk_client,
    )


async def load_oidc_config(
        app_state: Any,
        settings: Settings
) -> Optional[OidcConfiguration]:
    """
    Return the cached provider configuration, discovering it if necessary.

    Called once from the application lifespan so the cost and any failure are visible at
    startup. Discovery is retried on demand afterwards, so a provider that is briefly down
    while the service boots does not require a restart.
    """
    if not settings.auth_required:
        return None

    cached: Optional[OidcConfiguration] = getattr(app_state, "oidc_config", None)
    if cached is not None:
        return cached

    try:
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


def user_home_dir(claims: dict[str, Any]) -> str:
    """ Derive a filesystem-safe, human-readable per-user directory name from token claims. """
    subject = claims["sub"]
    digest = hashlib.sha3_256(subject.encode("utf-8")).hexdigest()[:12]

    username = claims.get("preferred_username")
    if not isinstance(username, str):
        return digest

    sanitized = re.sub(r'[^\w.-]', '_', username)[:48]
    candidate = f"{sanitized}-{digest}"

    return candidate if SAFE_NAME_REGEX.match(candidate) else digest


async def get_current_user_home(
        request: Request,
        settings: Annotated[Settings, Depends(get_settings)],
        credentials: Annotated[Optional[HTTPAuthorizationCredentials], Depends(security_scheme)],
) -> str:
    """ Resolve the caller's home directory name, rejecting unauthenticated requests. """
    if not settings.auth_required:
        return ANONYMOUS_HOME

    oidc_config = await load_oidc_config(request.app.state, settings)
    if oidc_config is None:
        raise _provider_unreachable()

    if credentials is None:
        raise _unauthenticated()

    claims = validate_access_token(credentials.credentials, oidc_config, settings)

    return user_home_dir(claims)
