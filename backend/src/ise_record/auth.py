from datetime import timedelta
from typing import Annotated, Any, NamedTuple, Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import httpx2
import jwt

from .settings import Settings, get_settings

security_scheme = HTTPBearer(auto_error=False)

class OpenIDConfiguration(NamedTuple):
    issuer: str
    jwks_uri: str
    jwks_cache: Optional[dict[str, Any]]

async def get_openid_config(
        request: Request,
        settings: Annotated[Settings, Depends(get_settings)]
) -> Optional[OpenIDConfiguration]:
    if not settings.openid_provider_url:
        return None

    if not hasattr(request.app.state, "openid_config"):
        async with httpx2.AsyncClient() as client:
            discovery_response = await client.get(f"{settings.openid_provider_url}/.well-known/openid-configuration")
            discovery_response.raise_for_status()
            issuer = discovery_response.json()["issuer"]
            jwks_uri = discovery_response.json()["jwks_uri"]

            jwks_response = await client.get(jwks_uri)
            jwks_response.raise_for_status()
            jwks_cache = jwks_response.json()

            request.app.state.openid_config = OpenIDConfiguration(
                issuer=issuer,
                jwks_uri=jwks_uri,
                jwks_cache=jwks_cache
            )

    return request.app.state.openid_config

def get_current_user(
        credentials: Annotated[HTTPAuthorizationCredentials, Depends(security_scheme)],
        openid_config: Annotated[Optional[OpenIDConfiguration], Depends(get_openid_config)],
        settings: Annotated[Settings, Depends(get_settings)]
) -> str:
    if not settings.openid_provider_url:
        return "."

    if not openid_config:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unable to contact OpenID provider"
        )

    try:
        payload = jwt.decode( # pyright: ignore[reportUnknownMemberType]
            credentials.credentials,
            openid_config.jwks_cache,
            algorithms=["RS256"],
            issuer=openid_config.issuer,
            options={"verify_aud": False},
            leeway=timedelta(seconds=30)
        )

        return payload["sub"]
    except jwt.exceptions.PyJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid or expired token"
        ) from e
