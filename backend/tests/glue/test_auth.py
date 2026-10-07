"""
The authentication dependables: how OidcClient's verdicts become responses, when the
UserInfo lookup is made, and what is cached per subject.

The OidcClient is a mock here -- what it accepts and what UserInfo answers is its own
contract, in core/test_auth_oidc.py. The end-to-end check that it is wired into the endpoints is
in test_server.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

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
from ise_record.settings import Settings

from .conftest import request_for

TOKEN = "header.payload.signature"
BEARER = HTTPAuthorizationCredentials(scheme="Bearer", credentials=TOKEN)


@pytest.fixture
def mock_oidc(mocker: MockerFixture) -> Any:
    """An OidcClient that accepts any token as the lecturer, and has no UserInfo to give."""
    client = mocker.create_autospec(OidcClient, instance=True)
    client.validate_access_token.return_value = {"sub": "abc", "preferred_username": "lecturer"}
    client.query_username.return_value = None
    return client


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
    assert await user_info(request_, auth_settings, mock_oidc) == UserInfo(
        sub="abc", preferred_username="lecturer"
    )

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


# --- the UserInfo fallback -------------------------------------------------


@pytest.mark.asyncio
async def test_userinfo_is_not_consulted_when_the_token_carries_the_username(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    await user_info(request_, auth_settings, mock_oidc)

    # the round trip is per user and on the upload path, so not making it is the point
    mock_oidc.query_username.assert_not_called()


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
    mock_oidc.query_username.return_value = "dozentin"

    assert await user_info(request_, auth_settings, mock_oidc) == UserInfo(
        sub="abc", preferred_username="dozentin"
    )

    # asked about this caller, with this caller's token as the credential
    mock_oidc.query_username.assert_awaited_once_with(TOKEN, "abc")


@pytest.mark.asyncio
async def test_no_answer_from_userinfo_is_a_user_without_a_name(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    # not an error: the name is only cosmetic, and the subject is what the home is named after
    mock_oidc.validate_access_token.return_value = {"sub": "abc"}

    assert await user_info(request_, auth_settings, mock_oidc) == UserInfo(
        sub="abc", preferred_username=None
    )


# --- what is cached --------------------------------------------------------


@pytest.mark.asyncio
async def test_userinfo_is_consulted_once_per_subject(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    mock_oidc.validate_access_token.return_value = {"sub": "abc"}
    mock_oidc.query_username.return_value = "dozentin"

    for _ in range(3):
        await user_info(request_, auth_settings, mock_oidc)

    mock_oidc.query_username.assert_awaited_once()


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
async def test_a_recovering_provider_does_not_rename_a_known_subject(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    # UserInfo unavailable for the first chunk, so this lecture starts without a name. The
    # rest of it has to be filed the same way, or get_enclave could be asked about
    # a different user halfway through a recording.
    mock_oidc.validate_access_token.return_value = {"sub": "abc"}
    first = await user_info(request_, auth_settings, mock_oidc)

    mock_oidc.query_username.return_value = "dozentin"
    second = await user_info(request_, auth_settings, mock_oidc)

    assert first == second == UserInfo(sub="abc", preferred_username=None)
    mock_oidc.query_username.assert_awaited_once()


@pytest.mark.asyncio
async def test_subjects_are_cached_apart(
    request_: Request, auth_settings: Settings, mock_oidc: Any
):
    mock_oidc.validate_access_token.return_value = {"sub": "user-a", "preferred_username": "anna"}
    await user_info(request_, auth_settings, mock_oidc)

    mock_oidc.validate_access_token.return_value = {"sub": "user-b", "preferred_username": "bernd"}

    assert await user_info(request_, auth_settings, mock_oidc) == UserInfo(
        sub="user-b", preferred_username="bernd"
    )


@pytest.mark.asyncio
async def test_two_apps_share_no_user_cache(auth_settings: Settings, mock_oidc: Any):
    # the cache once lived on the class rather than on the instance, so every app in the
    # process -- and every test -- read the users an earlier one had cached
    mock_oidc.validate_access_token.return_value = {"sub": "abc"}

    await user_info(request_for(auth_settings), auth_settings, mock_oidc)
    await user_info(request_for(auth_settings), auth_settings, mock_oidc)

    assert mock_oidc.query_username.await_count == 2


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
