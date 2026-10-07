"""
Fixtures for the tests that call the FastAPI dependables directly, without a request cycle.
"""

# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from anyio import Path
from fastapi import Request
import pytest

from ise_record.server import create_app
from ise_record.settings import OidcSettings, Settings


@pytest.fixture
def auth_settings(tmp_path: Path) -> Settings:
    """
    An authenticated deployment, without the stand-in provider the root conftest's has: the
    dependables only ask whether authentication is on, and nothing here talks to a provider.
    """
    return Settings(
        destdir=tmp_path, oidc=OidcSettings(provider_url="https://idp.example.edu", audience="ise")
    )


def request_for(app_settings: Settings) -> Request:
    """A bare request against a fresh app; the dependables only read app.state from it."""
    return Request(scope={"type": "http", "app": create_app(app_settings)})


@pytest.fixture
def request_(auth_settings: Settings) -> Request:
    return request_for(auth_settings)
