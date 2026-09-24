"""
Fixtures for the tests that call the FastAPI dependables directly, without a request cycle.
"""

# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from pathlib import Path

from fastapi import Request
import pytest

from ise_record.server import create_app
from ise_record.settings import OidcSettings, Settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    # the dependables only ask whether authentication is on; nothing here talks to a provider
    return Settings(
        destdir=tmp_path,
        oidc=OidcSettings(provider_url="https://idp.example.edu", audience="ise")
    )


@pytest.fixture
def open_settings(tmp_path: Path) -> Settings:
    """ A deployment with no provider configured, where every caller shares destdir. """
    return Settings(destdir=tmp_path)


def request_for(app_settings: Settings) -> Request:
    """ A bare request against a fresh app; the dependables only read app.state from it. """
    return Request(scope={ "type": "http", "app": create_app(app_settings) })


@pytest.fixture
def request_(settings: Settings) -> Request:
    return request_for(settings)
