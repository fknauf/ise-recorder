"""
The dependables that hand an endpoint the caller's enclave: the home directory, the running
jobs and the download OTPs that belong to one user, or to everyone in an open deployment.

What the directory is called, and the alias beside it, is prepare_user_home_dir's business
and lives in core/test_user_home.py; these cover when it is asked, and what is kept.
"""

# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

import asyncio
from pathlib import Path

from fastapi import HTTPException, Request
import pytest
from pytest_mock import MockerFixture

from ise_record.core.auth import UserInfo
from ise_record.core.recordings import BusyRecordings
from ise_record.core.user_home import prepare_user_home_dir
from ise_record.glue.enclave import Enclave, get_enclave, get_enclave_by_user_digest
from ise_record.settings import Settings

from ..harness import alias_of, digest_of, home_entries
from .conftest import request_for


@pytest.mark.asyncio
async def test_the_home_directory_is_prepared_under_destdir(
    request_: Request, settings: Settings, tmp_path: Path
):
    enclave = await get_enclave(request_, settings, UserInfo("abc", "lecturer"))

    assert enclave.home_dir == tmp_path / digest_of("abc")
    assert home_entries(tmp_path) == {digest_of("abc"), alias_of("lecturer", digest_of("abc"))}


@pytest.mark.asyncio
async def test_a_new_enclave_has_nothing_running(request_: Request, settings: Settings):
    enclave = await get_enclave(request_, settings, UserInfo("abc", "lecturer"))

    assert enclave.busy_recordings == BusyRecordings()
    assert not enclave.download_totp.factories


@pytest.mark.asyncio
async def test_an_open_deployment_shares_destdir(open_settings: Settings, tmp_path: Path):
    enclave = await get_enclave(request_for(open_settings), open_settings, None)

    assert enclave.home_dir == tmp_path
    assert home_entries(tmp_path) == set()


@pytest.mark.asyncio
async def test_every_caller_of_an_open_deployment_gets_the_same_enclave(open_settings: Settings):
    # there is nobody to tell apart, so a job one browser scheduled has to block the uploads
    # of every other
    request = request_for(open_settings)

    first = await get_enclave(request, open_settings, None)
    second = await get_enclave(request, open_settings, None)

    assert first is second


@pytest.mark.asyncio
async def test_no_user_under_authentication_is_an_internal_error(
    request_: Request, settings: Settings, tmp_path: Path
):
    # get_user_info raises before it would return None here, so this is a guard against a
    # wiring mistake -- and it must not fall back to the shared enclave, whose home is
    # destdir and holds every lecture on the server
    with pytest.raises(HTTPException) as excinfo:
        await get_enclave(request_, settings, None)

    assert excinfo.value.status_code == 500
    assert home_entries(tmp_path) == set()
    assert request_.app.state.enclaves == {}


@pytest.mark.asyncio
async def test_a_known_subject_keeps_its_enclave_without_preparing_it_again(
    request_: Request, settings: Settings, tmp_path: Path
):
    # the rest of a lecture has to keep landing beside its first chunk, and its job has to
    # stay in the set the next request looks in
    first = await get_enclave(request_, settings, UserInfo("abc", None))
    second = await get_enclave(request_, settings, UserInfo("abc", "lecturer"))

    assert first is second
    # no alias appears mid-lecture either: the second call was answered from the cache
    assert home_entries(tmp_path) == {digest_of("abc")}


@pytest.mark.asyncio
async def test_subjects_get_enclaves_of_their_own(request_: Request, settings: Settings):
    first = await get_enclave(request_, settings, UserInfo("user-a", "same"))
    second = await get_enclave(request_, settings, UserInfo("user-b", "same"))

    assert first.home_dir != second.home_dir
    assert first.busy_recordings is not second.busy_recordings
    assert first.download_totp is not second.download_totp


@pytest.mark.asyncio
async def test_two_first_requests_at_once_end_up_in_one_enclave(
    mocker: MockerFixture, request_: Request, settings: Settings
):
    # A lecturer's first requests arrive together -- the listing and the first chunks. If
    # each made an enclave of its own and the later one won, a job registered in the other
    # would be invisible to every later upload, listing and purge.
    async def preparation_that_yields(user_info: UserInfo, base_dir: Path) -> Path:
        await asyncio.sleep(0)
        return await prepare_user_home_dir(user_info, base_dir)

    mocker.patch(
        "ise_record.glue.enclave.prepare_user_home_dir", side_effect=preparation_that_yields
    )

    first, second = await asyncio.gather(
        get_enclave(request_, settings, UserInfo("abc", "lecturer")),
        get_enclave(request_, settings, UserInfo("abc", "lecturer")),
    )

    assert first is second


@pytest.mark.asyncio
async def test_the_enclave_is_found_again_by_the_digest_its_download_links_name(
    request_: Request, settings: Settings
):
    # the browser follows a download link without a token, so the digest in the URL is all
    # there is to find the authority that issued its OTP
    enclave = await get_enclave(request_, settings, UserInfo("abc", "lecturer"))

    assert await get_enclave_by_user_digest(request_, enclave.home_dir.name) is enclave


@pytest.mark.asyncio
async def test_a_digest_nobody_has_used_since_the_start_has_no_enclave(
    request_: Request, settings: Settings
):
    await get_enclave(request_, settings, UserInfo("abc", "lecturer"))

    assert await get_enclave_by_user_digest(request_, digest_of("someone-else")) is None


@pytest.mark.asyncio
async def test_looking_up_a_digest_makes_no_enclave(request_: Request):
    # anyone can follow a download link, so a lookup must not fill the server with enclaves
    await get_enclave_by_user_digest(request_, digest_of("abc"))

    assert await get_enclave_by_user_digest(request_, digest_of("abc")) is None


# --- refusing what a busy recording cannot take ------------------------------


def test_an_idle_recording_is_not_busy(tmp_path: Path):
    Enclave(tmp_path).assert_not_busy("GVS_2025")


def test_a_rendering_recording_is_busy(tmp_path: Path):
    enclave = Enclave(tmp_path)
    enclave.busy_recordings.rendering.add(tmp_path / "GVS_2025")

    with pytest.raises(HTTPException) as excinfo:
        enclave.assert_not_busy("GVS_2025")

    assert excinfo.value.status_code == 409
    assert excinfo.value.detail == "GVS_2025 is currently being rendered."


def test_a_recording_being_purged_is_busy(tmp_path: Path):
    enclave = Enclave(tmp_path)
    enclave.busy_recordings.purging.add(tmp_path / "GVS_2025")

    with pytest.raises(HTTPException) as excinfo:
        enclave.assert_not_busy("GVS_2025")

    assert excinfo.value.status_code == 409
    assert excinfo.value.detail == "GVS_2025 is currently being purged."


def test_the_refusal_does_not_claim_to_be_about_uploads(tmp_path: Path):
    # the purge endpoint refuses with it too, and the frontend shows the detail as it is
    enclave = Enclave(tmp_path)
    enclave.busy_recordings.rendering.add(tmp_path / "GVS_2025")

    with pytest.raises(HTTPException) as excinfo:
        enclave.assert_not_busy("GVS_2025")

    assert "upload" not in str(excinfo.value.detail).lower()


def test_another_recording_being_busy_does_not_count(tmp_path: Path):
    enclave = Enclave(tmp_path)
    enclave.busy_recordings.rendering.add(tmp_path / "BUSY_2025")
    enclave.busy_recordings.purging.add(tmp_path / "GONE_2025")

    enclave.assert_not_busy("GVS_2025")


def test_another_enclaves_busy_recording_of_the_same_name_does_not_count(tmp_path: Path):
    elsewhere = Enclave(tmp_path / "a")
    elsewhere.busy_recordings.rendering.add(elsewhere.home_dir / "GVS_2025")

    Enclave(tmp_path / "b").assert_not_busy("GVS_2025")
