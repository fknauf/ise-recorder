"""
OpenID Connect authentication client
"""

from dataclasses import dataclass
import logging
from typing import Any, NamedTuple

import httpx2
import jwt
from pydantic import BaseModel, ValidationError

REQUIRED_CLAIMS = ("exp", "iat", "iss", "aud", "sub")
JWKS_CACHE_SECONDS = 1800.0
JWKS_REFRESH_COOLDOWN_SECONDS = 30.0

INSECURE_ALGORITHMS = frozenset({"none", "hs256", "hs384", "hs512"})

logger = logging.getLogger(__name__)

class ProviderUnreachable(Exception):
    """ Exception class to signal that the OIDC provider was unreachable """

class Unauthenticated(Exception):
    """ Exception class to signal that a token could not be authenticated """

class UserInfoResponse(BaseModel):
    """ Part of the response of the OIDC provider's userinfo_endpoint, used for validation """
    sub: str
    preferred_username: str | None = None

@dataclass
class OidcClient:
    """ Oidc Client. Supports OIDC discovery, token validation, and userinfo queries """

    jwk_client: jwt.PyJWKClient
    issuer: str
    audience: str
    userinfo_endpoint: str
    leeway_seconds: float
    http_timeout_seconds: float

    @classmethod
    async def discover(
        cls,
        provider_url: str,
        audience: str,
        leeway_seconds: float,
        http_timeout_seconds: float
    ):
        """
        Fetch provider metadata from the well-known discovery endpoint and construct an OIDC client
        from it.
        """
        discovery_url = f"{provider_url.rstrip('/')}/.well-known/openid-configuration"

        async with httpx2.AsyncClient(timeout=http_timeout_seconds) as client:
            response = await client.get(discovery_url)
            response.raise_for_status()
            metadata = response.json()

        jwks_uri = metadata["jwks_uri"]
        jwk_client = jwt.PyJWKClient(
            jwks_uri,
            cache_jwk_set=True,
            lifespan=JWKS_CACHE_SECONDS,
            cooldown_duration=JWKS_REFRESH_COOLDOWN_SECONDS,
            timeout=http_timeout_seconds,
        )

        return OidcClient(
            jwk_client=jwk_client,
            issuer=metadata["issuer"],
            audience=audience,
            userinfo_endpoint=metadata.get("userinfo_endpoint"),
            leeway_seconds=leeway_seconds,
            http_timeout_seconds=http_timeout_seconds,
        )

    def validate_access_token(self, token: str) -> dict[str, Any]:
        """ Validate an access token and extract its claims. """

        try:
            signing_key = self.jwk_client.get_signing_key_from_jwt(token)
            algorithm = signing_key.algorithm_name

            if algorithm.lower() in INSECURE_ALGORITHMS:
                logger.error("key %s signs with %s, which we refuse to verify",
                            signing_key.key_id, algorithm)
                raise Unauthenticated()

            return jwt.decode(
                token,
                signing_key,
                algorithms=[algorithm],
                issuer=self.issuer,
                audience=self.audience,
                leeway=self.leeway_seconds,
                options={
                    "require": list(REQUIRED_CLAIMS)
                },
            )
        except jwt.PyJWKClientConnectionError as exc:
            logger.error("cannot reach the JWKS endpoint: %s", exc)
            raise ProviderUnreachable() from exc
        except jwt.PyJWKClientError as exc:
            logger.warning("no usable signing key for the presented token: %s", exc)
            raise Unauthenticated() from exc
        except jwt.PyJWTError as exc:
            logger.info("rejected access token: %s", exc)
            raise Unauthenticated() from exc

    async def query_username(
            self,
            access_token: str,
            subject: str
    ) -> str | None:
        """ Fallback query to oidc provider if preferred_username isn't in the access token. """

        if self.userinfo_endpoint is None:
            return None

        try:
            async with httpx2.AsyncClient(timeout=self.http_timeout_seconds) as client:
                response = await client.get(
                    self.userinfo_endpoint,
                    headers={ "Authorization": f"Bearer {access_token}" }
                )

                if response.status_code != 200:
                    logger.warning("Unable to query userinfo: %s", response.text[:48])
                    return None

                userinfo = UserInfoResponse.model_validate_json(response.content)

                if userinfo.sub != subject:
                    logger.warning(
                        "Discarding userinfo: endpoint returned info for %s when asked about %s",
                        userinfo.sub, subject)
                    return None

                return userinfo.preferred_username
        except (httpx2.HTTPError, httpx2.InvalidURL, ValidationError) as e:
            logger.warning("Unable to query openid user info %s", e)
            return None


class UserInfo(NamedTuple):
    """ User information used in the ise-recorder backend """
    sub: str
    preferred_username: str | None = None
