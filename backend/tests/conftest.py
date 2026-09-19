"""
Isolation of the test suite from the deployment environment.

Settings come from ISE_RECORD_* environment variables, and `ise_record.server` builds its
FastAPI app at import time (`app = create_app()`) from `get_settings()`, which is
lru_cached. So anyone who has actually deployed this -- or who merely runs the compose
stack on the same machine -- gets a different app and different settings than CI does, and
watches tests fail for reasons unconnected to their change. Verified before this existed:
`ISE_RECORD_DESTDIR=/tmp/elsewhere pytest` failed three tests in test_server.py.

The scrub runs at import rather than in the fixture because pytest imports conftest before
it collects test modules, which is the only point still ahead of `create_app()`. The
fixture then covers the rest: a cached Settings from an earlier test cannot leak forward.
"""

# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

import os
from pathlib import Path
from typing import Iterator

from fastapi.testclient import TestClient
import jwt
import pytest

from harness import AUDIENCE, Provider
from ise_record import auth
from ise_record.auth import OidcConfiguration
from ise_record.server import create_app
from ise_record.settings import get_settings, OidcSettings, Settings

# matches SettingsConfigDict(env_prefix=...); pydantic matches it case-insensitively, so
# clearing it case-insensitively too avoids a lowercase var slipping through
ENV_PREFIX = "ise_record_"

def scrub_deployment_environment() -> None:
    """ Remove every setting the deployment might have configured. """
    for name in [ n for n in os.environ if n.lower().startswith(ENV_PREFIX) ]:
        del os.environ[name]

scrub_deployment_environment()

@pytest.fixture(autouse=True)
def isolated_settings():
    """ Give every test the documented defaults, whatever the machine is configured for. """
    scrub_deployment_environment()
    get_settings.cache_clear()

    yield

    get_settings.cache_clear()


# --- a backend with authentication turned on -------------------------------

# test_server.py drives an unauthenticated deployment and calls its own fixtures `settings`
# and `client`; these are named apart from those so that a file holding both kinds of test
# says in each signature which backend it is talking to.

@pytest.fixture
def provider() -> Iterator[Provider]:
    """ A stand-in OpenID provider, serving discovery and JWKS over a real socket. """
    instance = Provider()
    instance.add_key("key-1")
    instance.start()
    yield instance
    instance.stop()


@pytest.fixture
def auth_settings(provider: Provider, tmp_path: Path) -> Settings:
    return Settings(
        destdir=tmp_path,
        oidc=OidcSettings(
            provider_url=provider.issuer,
            audience=AUDIENCE
        )
    )


@pytest.fixture
def fresh_auth_settings(provider: Provider, tmp_path: Path) -> Settings:
    """ Settings for a second app, so a test can start one that shares no cached state. """
    return Settings(
        destdir=tmp_path / "fresh",
        oidc=OidcSettings(
            provider_url=provider.issuer,
            audience=AUDIENCE
        )
    )


@pytest.fixture
def auth_client(auth_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(auth_settings)) as test_client:
        yield test_client


@pytest.fixture
def oidc(provider: Provider) -> OidcConfiguration:
    """ What discovery would have produced, for the tests that bypass the app. """
    return OidcConfiguration(
        issuer=provider.issuer,
        userinfo_endpoint=f"{provider.issuer}/userinfo",
        http_timeout=5.0,
        jwk_client=jwt.PyJWKClient(f"{provider.issuer}/jwks"),
    )


@pytest.fixture
def instant_jwks_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Let an unknown kid refetch the key set immediately, instead of after the cooldown.

    Rotation takes milliseconds here and half a minute in production, so without this a
    rotation test would only be measuring PyJWKClient's rate limit. The cooldown is read
    when the client is constructed, which is when the app starts up -- request this
    fixture ahead of `auth_client` so it is patched by then.
    """
    monkeypatch.setattr(auth, "JWKS_REFRESH_COOLDOWN_SECONDS", 0.0)
