"""
Fixtures for the tests that talk to core modules directly, without an app in between.
"""

# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

import pytest
import pytest_asyncio

from ise_record.core import auth
from ise_record.core.auth import OidcClient

from ..harness import AUDIENCE, Provider


async def discover(provider: Provider, audience: str = AUDIENCE) -> OidcClient:
    """An OidcClient built the way the app builds one at startup."""
    return await OidcClient.discover(
        provider_url=provider.issuer,
        audience=audience,
        leeway_seconds=30.0,
        http_timeout_seconds=5.0,
    )


@pytest_asyncio.fixture
async def oidc(provider: Provider) -> OidcClient:
    return await discover(provider)


@pytest.fixture
def instant_jwks_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Let an unknown kid refetch the key set immediately, instead of after the cooldown.

    Rotation takes milliseconds here and half a minute in production, so without this a
    rotation test would only be measuring PyJWKClient's rate limit. The cooldown is read
    when the client is discovered -- request this fixture ahead of `oidc` so it is patched
    by then.
    """
    monkeypatch.setattr(auth, "JWKS_REFRESH_COOLDOWN_SECONDS", 0.0)
