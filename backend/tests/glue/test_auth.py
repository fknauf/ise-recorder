"""
The authentication dependables: how OidcClient's verdicts become responses, when the
UserInfo lookup is made, how its answer and the token's claims are put together, and how long
an answer is kept per subject.

The OidcClient is a mock here -- what it accepts and what UserInfo answers is its own
contract, in core/test_auth_oidc.py. The end-to-end check that it is wired into the endpoints is
in test_server.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from datetime import datetime, timedelta, UTC
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from fastapi import HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
import httpx2
import pytest
from pytest_mock import MockerFixture

from ise_record.core.auth import OidcClient, ProviderUnreachable, Unauthenticated, UserInfo
from ise_record.glue.auth import get_user_info, load_oidc_client, OidcServerState
from ise_record.settings import OidcSettings, Settings

from .conftest import request_for

TOKEN = "header.payload.signature"
BEARER = HTTPAuthorizationCredentials(scheme="Bearer", credentials=TOKEN)


# Everything the backend wants from a provider, in the access token itself -- Keycloak's default
COMPLETE_CLAIMS: dict[str, Any] = {
    "sub": "abc",
    "preferred_username": "lecturer",
    "email": "lecturer@example.edu",
    "email_verified": True,
}


@pytest.fixture
def mock_oidc(mocker: MockerFixture) -> Any:
    """An OidcClient that accepts any token as the lecturer, and has no UserInfo to give."""
    client = mocker.create_autospec(OidcClient, instance=True)
    client.validate_access_token.return_value = {"sub": "abc", "preferred_username": "lecturer"}
    client.query_userinfo.return_value = None
    return client


class Clock:
    """Stands in for datetime in glue.auth, so a test can let a cached answer run out."""

    def __init__(self) -> None:
        self.current = datetime(2026, 10, 13, 12, 0, tzinfo=UTC)

    def now(self, tz: Any = None) -> datetime:
        return self.current.astimezone(tz) if tz is not None else self.current

    def advance(self, **delta: float) -> None:
        self.current += timedelta(**delta)


@pytest.fixture
def clock(mocker: MockerFixture) -> Clock:
    fake = Clock()
    mocker.patch("ise_record.glue.auth.datetime", fake)
    return fake


def answer(**fields: Any) -> UserInfo:
    """What UserInfo says about the lecturer"""
    return UserInfo(sub="abc", **fields)


async def user_info(request: Request, auth_settings: Settings, mock_oidc: Any) -> UserInfo | None:
    return await get_user_info(request, auth_settings, mock_oidc, BEARER)


async def rejection(
    request: Request, auth_settings: Settings, mock_oidc: Any, credentials: Any = BEARER
) -> HTTPException:
    with pytest.raises(HTTPException) as excinfo:
        await get_user_info(request, auth_settings, mock_oidc, credentials)
    return excinfo.value


# --- who the caller is -----------------------------------------------------


@pytest.mark.asyncio
async def test_the_caller_is_who_the_token_says(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    mock_oidc.validate_access_token.return_value = COMPLETE_CLAIMS

    assert await user_info(request_, auth_settings, mock_oidc) == UserInfo(**COMPLETE_CLAIMS)

    mock_oidc.validate_access_token.assert_called_once_with(TOKEN)


@pytest.mark.asyncio
async def test_an_open_deployment_has_no_user_and_asks_nobody(settings: Settings, mock_oidc: Any):
    # not even a missing token is an error: there is nobody to authenticate against
    assert await get_user_info(request_for(settings), settings, mock_oidc, None) is None

    mock_oidc.validate_access_token.assert_not_called()


# --- what becomes which response -------------------------------------------


@pytest.mark.asyncio
async def test_a_missing_token_is_a_401_with_a_bearer_challenge(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    error = await rejection(request_, auth_settings, mock_oidc, credentials=None)

    assert error.status_code == 401
    assert error.headers == {"WWW-Authenticate": "Bearer"}


@pytest.mark.asyncio
async def test_a_token_the_client_rejects_is_a_401(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    mock_oidc.validate_access_token.side_effect = Unauthenticated()

    error = await rejection(request_, auth_settings, mock_oidc)

    assert error.status_code == 401
    assert error.headers == {"WWW-Authenticate": "Bearer"}


@pytest.mark.asyncio
async def test_a_provider_the_client_cannot_reach_is_a_503(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    # not a 401: the token may be perfectly good, and telling the frontend otherwise would
    # send the lecturer to log in again for nothing
    mock_oidc.validate_access_token.side_effect = ProviderUnreachable()

    assert (await rejection(request_, auth_settings, mock_oidc)).status_code == 503


@pytest.mark.asyncio
async def test_a_provider_that_was_never_discovered_is_a_503(
    request_: Request, auth_settings: Settings
):
    assert (await rejection(request_, auth_settings, None)).status_code == 503


@pytest.mark.parametrize("subject", [42, None, ["abc"]])
@pytest.mark.asyncio
async def test_a_subject_that_is_not_a_string_is_a_401(
    request_: Request, auth_settings: Settings, mock_oidc: Any, subject: Any
):
    # the subject names the home directory; a token that validates but does not carry a
    # usable one identifies nobody
    mock_oidc.validate_access_token.return_value = {"sub": subject}

    assert (await rejection(request_, auth_settings, mock_oidc)).status_code == 401


@pytest.mark.asyncio
async def test_claims_the_token_gets_wrong_do_not_turn_the_caller_away(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    # a name or an address the provider wrote oddly is no reason to refuse a chunk upload
    mock_oidc.validate_access_token.return_value = {
        "sub": "abc",
        "preferred_username": 42,
        "email_verified": "maybe",
    }

    assert await user_info(request_, auth_settings, mock_oidc) == UserInfo(sub="abc")


# --- the UserInfo fallback -------------------------------------------------


@pytest.mark.asyncio
async def test_userinfo_is_not_consulted_when_the_token_carries_everything(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    mock_oidc.validate_access_token.return_value = COMPLETE_CLAIMS

    await user_info(request_, auth_settings, mock_oidc)

    # the round trip is per user and on the upload path, so not making it is the point
    mock_oidc.query_userinfo.assert_not_called()


@pytest.mark.parametrize(
    "claims",
    [
        pytest.param({"sub": "abc"}, id="kanidm: nothing but the subject"),
        pytest.param(
            {"sub": "abc", "preferred_username": "lecturer"}, id="okta, auth0: no address"
        ),
        pytest.param(
            {"sub": "abc", "preferred_username": "lecturer", "email": "lecturer@example.edu"},
            id="entra: an address nobody vouches for",
        ),
        pytest.param(
            {"sub": "abc", "email": "lecturer@example.edu", "email_verified": True},
            id="no username",
        ),
    ],
)
@pytest.mark.asyncio
async def test_userinfo_is_consulted_when_the_token_lacks_anything(
    request_: Request, auth_settings: Settings, mock_oidc: Any, claims: dict[str, Any]
):
    mock_oidc.validate_access_token.return_value = claims

    await user_info(request_, auth_settings, mock_oidc)

    # asked about this caller, with this caller's token as the credential
    mock_oidc.query_userinfo.assert_awaited_once_with(TOKEN, "abc")


@pytest.mark.parametrize(
    "claims",
    [
        {"sub": "abc"},
        {"sub": "abc", "preferred_username": 42},
        {"sub": "abc", "preferred_username": None},
    ],
)
@pytest.mark.asyncio
async def test_the_username_comes_from_userinfo_when_the_token_has_none(
    request_: Request, auth_settings: Settings, mock_oidc: Any, claims: dict[str, Any]
):
    mock_oidc.validate_access_token.return_value = claims
    mock_oidc.query_userinfo.return_value = answer(preferred_username="dozentin")

    assert (await user_info(request_, auth_settings, mock_oidc)).preferred_username == "dozentin"


@pytest.mark.asyncio
async def test_what_the_token_says_wins_over_userinfo(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    # The token was issued minutes ago, the UserInfo answer may be an hour old. No username in
    # this token, so UserInfo is asked -- but only for what the token does not carry.
    mock_oidc.validate_access_token.return_value = {
        "sub": "abc",
        "email": "lecturer@example.edu",
        "email_verified": False,
    }
    mock_oidc.query_userinfo.return_value = answer(
        preferred_username="dozentin", email="old@example.edu", email_verified=True
    )

    assert await user_info(request_, auth_settings, mock_oidc) == answer(
        preferred_username="dozentin", email="lecturer@example.edu", email_verified=False
    )


@pytest.mark.asyncio
async def test_an_address_and_its_verification_are_taken_together(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    # The token has an address but says nothing about it. UserInfo vouching for some address
    # says nothing about this one -- the user may have changed it since -- so the pair comes
    # from UserInfo, which is the provider's word on the address it holds now.
    mock_oidc.validate_access_token.return_value = {
        "sub": "abc",
        "preferred_username": "lecturer",
        "email": "lecturer@example.edu",
    }
    mock_oidc.query_userinfo.return_value = answer(
        email="dozentin@example.edu", email_verified=True
    )

    result = await user_info(request_, auth_settings, mock_oidc)

    assert (result.email, result.email_verified) == ("dozentin@example.edu", True)


@pytest.mark.asyncio
async def test_an_address_userinfo_no_longer_has_is_not_used(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    # UserInfo answering without one means the provider holds none now; the token's copy is
    # what it held when the token was issued
    mock_oidc.validate_access_token.return_value = {
        "sub": "abc",
        "preferred_username": "lecturer",
        "email": "lecturer@example.edu",
    }
    mock_oidc.query_userinfo.return_value = answer(preferred_username="lecturer")

    result = await user_info(request_, auth_settings, mock_oidc)

    assert (result.email, result.email_verified) == (None, None)


@pytest.mark.asyncio
async def test_no_answer_from_userinfo_leaves_what_the_token_says(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    # not an error: the name is only cosmetic, the subject is what the home is named after, and
    # an address the token does carry is still the best there is
    mock_oidc.validate_access_token.return_value = {"sub": "abc", "email": "lecturer@example.edu"}

    assert await user_info(request_, auth_settings, mock_oidc) == UserInfo(
        sub="abc", email="lecturer@example.edu"
    )


# --- how long an answer is kept --------------------------------------------
#
# The chunk uploads of a lecture come every few seconds, and every one of them is authenticated,
# so UserInfo is asked once and the answer kept. Kept for a while rather than for good: the
# address it carries is where the reports go, and an address the user changes at the provider
# has to arrive here eventually.

ANSWER_LIFETIME = timedelta(hours=1)  # OidcSettings.userinfo_cache_seconds' default
RETRY_AFTER_FAILURE = timedelta(minutes=5)


@pytest.fixture
def incomplete_token(mock_oidc: Any) -> None:
    mock_oidc.validate_access_token.return_value = {"sub": "abc"}


@pytest.mark.usefixtures("incomplete_token", "clock")
@pytest.mark.asyncio
async def test_userinfo_is_consulted_once_while_its_answer_is_fresh(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    mock_oidc.query_userinfo.return_value = answer(preferred_username="dozentin")

    for _ in range(3):
        assert (
            await user_info(request_, auth_settings, mock_oidc)
        ).preferred_username == "dozentin"

    mock_oidc.query_userinfo.assert_awaited_once()


@pytest.mark.usefixtures("incomplete_token")
@pytest.mark.asyncio
async def test_an_answer_is_asked_for_again_once_it_has_run_out(
    request_: Request, auth_settings: Settings, mock_oidc: Any, clock: Clock
):
    mock_oidc.query_userinfo.return_value = answer(email="old@example.edu", email_verified=True)
    await user_info(request_, auth_settings, mock_oidc)

    mock_oidc.query_userinfo.return_value = answer(email="new@example.edu", email_verified=True)
    clock.advance(seconds=ANSWER_LIFETIME.total_seconds() - 1)
    assert (await user_info(request_, auth_settings, mock_oidc)).email == "old@example.edu"

    clock.advance(seconds=2)
    assert (await user_info(request_, auth_settings, mock_oidc)).email == "new@example.edu"
    assert mock_oidc.query_userinfo.await_count == 2


@pytest.mark.usefixtures("incomplete_token")
@pytest.mark.asyncio
async def test_how_long_an_answer_is_kept_is_configurable(
    tmp_path: Any, mock_oidc: Any, clock: Clock
):
    configured = Settings(
        destdir=tmp_path,
        oidc=OidcSettings(
            provider_url="https://idp.example.edu", audience="ise", userinfo_cache_seconds=60
        ),
    )
    request = request_for(configured)
    mock_oidc.query_userinfo.return_value = answer(preferred_username="dozentin")

    await user_info(request, configured, mock_oidc)
    clock.advance(seconds=61)
    await user_info(request, configured, mock_oidc)

    assert mock_oidc.query_userinfo.await_count == 2


@pytest.mark.usefixtures("incomplete_token")
@pytest.mark.asyncio
async def test_a_refresh_that_fails_keeps_the_answer_it_had(
    request_: Request, auth_settings: Settings, mock_oidc: Any, clock: Clock
):
    # a provider that is briefly down when the hour is up must not cost the lecturer the report
    # of the lecture they are giving -- not even when the request that hits the outage is the
    # render request itself
    mock_oidc.query_userinfo.return_value = answer(
        email="lecturer@example.edu", email_verified=True
    )
    await user_info(request_, auth_settings, mock_oidc)

    mock_oidc.query_userinfo.return_value = None
    clock.advance(seconds=ANSWER_LIFETIME.total_seconds() + 1)

    assert (await user_info(request_, auth_settings, mock_oidc)).email == "lecturer@example.edu"
    assert (await user_info(request_, auth_settings, mock_oidc)).email == "lecturer@example.edu"


@pytest.mark.usefixtures("incomplete_token")
@pytest.mark.asyncio
async def test_a_failed_refresh_is_retried_after_a_while_rather_than_on_every_request(
    request_: Request, auth_settings: Settings, mock_oidc: Any, clock: Clock
):
    # each attempt at a provider that is down can take the whole HTTP timeout, and the requests
    # that would wait for it are the chunk uploads
    mock_oidc.query_userinfo.return_value = answer(email="old@example.edu", email_verified=True)
    await user_info(request_, auth_settings, mock_oidc)
    mock_oidc.query_userinfo.return_value = None
    clock.advance(seconds=ANSWER_LIFETIME.total_seconds() + 1)
    await user_info(request_, auth_settings, mock_oidc)

    mock_oidc.query_userinfo.return_value = answer(email="new@example.edu", email_verified=True)
    clock.advance(seconds=RETRY_AFTER_FAILURE.total_seconds() - 1)
    await user_info(request_, auth_settings, mock_oidc)
    assert mock_oidc.query_userinfo.await_count == 2

    clock.advance(seconds=2)
    assert (await user_info(request_, auth_settings, mock_oidc)).email == "new@example.edu"
    assert mock_oidc.query_userinfo.await_count == 3


@pytest.mark.usefixtures("incomplete_token")
@pytest.mark.asyncio
async def test_a_provider_that_never_answered_is_not_asked_on_every_request(
    request_: Request, auth_settings: Settings, mock_oidc: Any, clock: Clock
):
    for _ in range(3):
        assert await user_info(request_, auth_settings, mock_oidc) == UserInfo(sub="abc")
    assert mock_oidc.query_userinfo.await_count == 1

    mock_oidc.query_userinfo.return_value = answer(preferred_username="dozentin")
    clock.advance(seconds=RETRY_AFTER_FAILURE.total_seconds() + 1)

    assert (await user_info(request_, auth_settings, mock_oidc)).preferred_username == "dozentin"
    assert mock_oidc.query_userinfo.await_count == 2


@pytest.mark.asyncio
async def test_every_request_is_validated_even_for_a_known_subject(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    # the cache holds who a subject is, not that the caller is them: a request with an
    # expired token must not ride on the one that came before it
    await user_info(request_, auth_settings, mock_oidc)
    mock_oidc.validate_access_token.side_effect = Unauthenticated()

    assert (await rejection(request_, auth_settings, mock_oidc)).status_code == 401
    assert mock_oidc.validate_access_token.call_count == 2


@pytest.mark.asyncio
async def test_subjects_are_cached_apart(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    mock_oidc.validate_access_token.return_value = {"sub": "user-a"}
    mock_oidc.query_userinfo.return_value = UserInfo(sub="user-a", email="anna@example.edu")
    await user_info(request_, auth_settings, mock_oidc)

    mock_oidc.validate_access_token.return_value = {"sub": "user-b"}
    mock_oidc.query_userinfo.return_value = UserInfo(sub="user-b", email="bernd@example.edu")

    assert (await user_info(request_, auth_settings, mock_oidc)).email == "bernd@example.edu"


@pytest.mark.asyncio
async def test_two_apps_share_no_user_cache(auth_settings: Settings, mock_oidc: Any):
    # the cache once lived on the class rather than on the instance, so every app in the
    # process -- and every test -- read the users an earlier one had cached
    mock_oidc.validate_access_token.return_value = {"sub": "abc"}

    await user_info(request_for(auth_settings), auth_settings, mock_oidc)
    await user_info(request_for(auth_settings), auth_settings, mock_oidc)

    assert mock_oidc.query_userinfo.await_count == 2


# --- discovery -------------------------------------------------------------


def app_state() -> Any:
    return SimpleNamespace(oidc=OidcServerState())


@pytest.fixture
def mock_discover(mocker: MockerFixture, mock_oidc: Any) -> AsyncMock:
    return mocker.patch(
        "ise_record.glue.auth.OidcClient.discover", autospec=True, return_value=mock_oidc
    )


@pytest.mark.asyncio
async def test_discovery_is_done_once_and_kept(
    auth_settings: Settings, mock_oidc: Any, mock_discover: AsyncMock
):
    state = app_state()

    assert await load_oidc_client(state, auth_settings.oidc) is mock_oidc
    assert await load_oidc_client(state, auth_settings.oidc) is mock_oidc

    mock_discover.assert_awaited_once()


@pytest.mark.asyncio
async def test_discovery_uses_the_configured_provider(
    auth_settings: Settings, mock_discover: AsyncMock
):
    await load_oidc_client(app_state(), auth_settings.oidc)

    assert auth_settings.oidc is not None

    mock_discover.assert_awaited_once_with(
        provider_url=auth_settings.oidc.provider_url,
        audience=auth_settings.oidc.audience,
        leeway_seconds=auth_settings.oidc.leeway_seconds,
        http_timeout_seconds=auth_settings.oidc.http_timeout_seconds,
    )


@pytest.mark.parametrize(
    "failure",
    [
        httpx2.ConnectError("connection refused"),
        KeyError("jwks_uri"),
        ValueError("not json"),
    ],
)
@pytest.mark.asyncio
async def test_a_failed_discovery_is_retried_on_the_next_request(
    auth_settings: Settings, mock_oidc: Any, mock_discover: AsyncMock, failure: Exception
):
    # a provider that is briefly down while the service boots must not need a restart
    mock_discover.side_effect = [failure, mock_oidc]
    state = app_state()

    assert await load_oidc_client(state, auth_settings.oidc) is None
    assert await load_oidc_client(state, auth_settings.oidc) is mock_oidc


@pytest.mark.asyncio
async def test_an_open_deployment_discovers_nothing(settings: Settings, mock_discover: AsyncMock):
    assert await load_oidc_client(app_state(), settings.oidc) is None

    mock_discover.assert_not_awaited()
