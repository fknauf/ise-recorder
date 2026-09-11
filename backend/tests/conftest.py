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

import os

import pytest

from ise_record.settings import get_settings

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
