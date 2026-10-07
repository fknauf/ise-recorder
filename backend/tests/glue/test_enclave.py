"""
The enclave: everything that belongs to one user's recordings, or to everyone's in an open
deployment -- where they are kept, what is happening to them, and the OTPs for downloading
them -- behind one facade that the endpoints talk to by recording name. And the dependables
that hand an endpoint the caller's enclave.

What the directory is called, and the alias beside it, is prepare_user_home_dir's business
and lives in core/test_user_home.py; what the claims allow alongside each other is the
tracker's, in core/test_recordings.py. These cover what the facade makes of them.
"""

# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

import asyncio
from pathlib import Path
import shutil

import anyio
from fastapi import HTTPException, Request
import pytest
from pytest_mock import MockerFixture

from ise_record.core.auth import UserInfo
from ise_record.core.recordings import RecordingActivity, RecordingDiskState
from ise_record.core.user_home import prepare_user_home_dir
from ise_record.glue.enclave import Enclave, get_enclave, get_enclave_by_user_digest
from ise_record.settings import Settings

from ..harness import abandon_recording, alias_of, digest_of, finish_recording, home_entries
from .conftest import request_for


@pytest.mark.asyncio
async def test_the_home_directory_is_prepared_under_destdir(
    request_: Request, auth_settings: Settings, tmp_path: Path
):
    enclave = await get_enclave(request_, auth_settings, UserInfo("abc", "lecturer"))

    assert enclave.recording_dir("GVS_2025") == tmp_path / digest_of("abc") / "GVS_2025"
    assert home_entries(tmp_path) == {digest_of("abc"), alias_of("lecturer", digest_of("abc"))}


@pytest.mark.asyncio
async def test_a_new_enclave_has_nothing_running(request_: Request, auth_settings: Settings):
    enclave = await get_enclave(request_, auth_settings, UserInfo("abc", "lecturer"))

    assert enclave.activity("GVS_2025") == RecordingActivity.NONE
    assert not enclave.verify_totp("0000000000", "GVS_2025")


@pytest.mark.asyncio
async def test_an_open_deployment_shares_destdir(settings: Settings, tmp_path: Path):
    enclave = await get_enclave(request_for(settings), settings, None)

    assert enclave.recording_dir("GVS_2025") == tmp_path / "GVS_2025"
    assert enclave.user_digest() is None
    assert home_entries(tmp_path) == set()


@pytest.mark.asyncio
async def test_every_caller_of_an_open_deployment_gets_the_same_enclave(settings: Settings):
    # there is nobody to tell apart, so a job one browser scheduled has to block the uploads
    # of every other
    request = request_for(settings)

    first = await get_enclave(request, settings, None)
    second = await get_enclave(request, settings, None)

    assert first is second


@pytest.mark.asyncio
async def test_no_user_under_authentication_is_an_internal_error(
    request_: Request, auth_settings: Settings, tmp_path: Path
):
    # get_user_info raises before it would return None here, so this is a guard against a
    # wiring mistake -- and it must not fall back to the shared enclave, whose home is
    # destdir and holds every lecture on the server
    with pytest.raises(HTTPException) as excinfo:
        await get_enclave(request_, auth_settings, None)

    assert excinfo.value.status_code == 500
    assert home_entries(tmp_path) == set()
    assert request_.app.state.enclaves == {}


@pytest.mark.asyncio
async def test_a_known_subject_keeps_its_enclave_without_preparing_it_again(
    request_: Request, auth_settings: Settings, tmp_path: Path
):
    # the rest of a lecture has to keep landing beside its first chunk, and its job has to
    # stay in the set the next request looks in
    first = await get_enclave(request_, auth_settings, UserInfo("abc", None))
    second = await get_enclave(request_, auth_settings, UserInfo("abc", "lecturer"))

    assert first is second
    # no alias appears mid-lecture either: the second call was answered from the cache
    assert home_entries(tmp_path) == {digest_of("abc")}


@pytest.mark.asyncio
async def test_subjects_get_enclaves_of_their_own(request_: Request, auth_settings: Settings):
    first = await get_enclave(request_, auth_settings, UserInfo("user-a", "same"))
    second = await get_enclave(request_, auth_settings, UserInfo("user-b", "same"))

    assert first.recording_dir("foo") != second.recording_dir("foo")

    with first.claim_rendering("foo"):
        assert second.activity("foo") == RecordingActivity.NONE

    assert not second.verify_totp(first.generate_totp("foo"), "foo")


@pytest.mark.asyncio
async def test_two_first_requests_at_once_end_up_in_one_enclave(
    mocker: MockerFixture, request_: Request, auth_settings: Settings
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
        get_enclave(request_, auth_settings, UserInfo("abc", "lecturer")),
        get_enclave(request_, auth_settings, UserInfo("abc", "lecturer")),
    )

    assert first is second


@pytest.mark.asyncio
async def test_the_enclave_is_found_again_by_the_digest_its_download_links_name(
    request_: Request, auth_settings: Settings
):
    # the browser follows a download link without a token, so the digest in the URL is all
    # there is to find the authority that issued its OTP
    enclave = await get_enclave(request_, auth_settings, UserInfo("abc", "lecturer"))

    assert enclave.user_digest() == digest_of("abc")
    assert await get_enclave_by_user_digest(request_, digest_of("abc")) is enclave


@pytest.mark.asyncio
async def test_a_digest_nobody_has_used_since_the_start_has_no_enclave(
    request_: Request, auth_settings: Settings
):
    await get_enclave(request_, auth_settings, UserInfo("abc", "lecturer"))

    assert await get_enclave_by_user_digest(request_, digest_of("someone-else")) is None


@pytest.mark.asyncio
async def test_looking_up_a_digest_makes_no_enclave(request_: Request):
    # anyone can follow a download link, so a lookup must not fill the server with enclaves
    await get_enclave_by_user_digest(request_, digest_of("abc"))

    assert await get_enclave_by_user_digest(request_, digest_of("abc")) is None


# --- the facade -------------------------------------------------------------
#
# The endpoints only ever name a recording; the facade turns the name into a path in the
# enclave's home directory and hands it to the tracker, the disk and the OTP authority.


@pytest.fixture
def enclave(tmp_path: Path) -> Enclave:
    return Enclave(digest_of("abc"), anyio.Path(tmp_path))


def test_a_refused_claim_answers_with_a_conflict(enclave: Enclave):
    # the endpoints let the HTTPException through as it is, so a busy recording is a 409
    # rather than a 500 from an exception nobody caught
    with enclave.claim_rendering("GVS_2025"):
        for claim in [enclave.claim_rendering, enclave.claim_purging]:
            with pytest.raises(HTTPException) as excinfo, claim("GVS_2025"):
                pytest.fail("claimed a recording that is being rendered")

            assert excinfo.value.status_code == 409

    with enclave.claim_purging("GVS_2025"):
        with pytest.raises(HTTPException) as excinfo, enclave.claim_upload("GVS_2025"):
            pytest.fail("uploaded into a recording being purged")

        assert excinfo.value.status_code == 409


def test_a_refused_claim_leaves_the_claim_in_the_way_alone(enclave: Enclave):
    with enclave.claim_rendering("GVS_2025"):
        with pytest.raises(HTTPException), enclave.claim_purging("GVS_2025"):
            pass

        assert enclave.activity("GVS_2025") == RecordingActivity.RENDERING


def test_a_claim_reaches_only_the_recording_it_names(enclave: Enclave):
    with enclave.claim_rendering("BUSY_2025"), enclave.claim_purging("GONE_2025"):
        assert enclave.activity("GVS_2025") == RecordingActivity.NONE

        with enclave.claim_purging("GVS_2025"):
            pass


def test_another_enclaves_busy_recording_of_the_same_name_does_not_count(tmp_path: Path):
    elsewhere = Enclave(digest_of("a"), anyio.Path(tmp_path / "a"))
    here = Enclave(digest_of("b"), anyio.Path(tmp_path / "b"))

    with elsewhere.claim_rendering("GVS_2025"), here.claim_purging("GVS_2025"):
        pass


def test_an_upload_through_the_facade_makes_the_recording_live(enclave: Enclave, tmp_path: Path):
    # the tracker keys what it knows by path; the facade has to hand it the same path for
    # the upload as for the question, or the upload is filed where nobody looks
    abandon_recording(tmp_path, "GVS_2025")

    with enclave.claim_upload("GVS_2025"):
        pass

    assert anyio.run(enclave.streaming, "GVS_2025")


def test_the_disk_state_is_read_from_the_home_directory(enclave: Enclave, tmp_path: Path):
    finish_recording(tmp_path, "DONE_2025")
    abandon_recording(tmp_path, "FAILED_2025")

    # all in one event loop, as in the server: the enclave's lock belongs to the first loop it
    # is used in
    async def disk_states() -> list[RecordingDiskState]:
        return [
            await enclave.disk_state(name) for name in ("DONE_2025", "FAILED_2025", "NEVER_2025")
        ]

    assert anyio.run(disk_states) == [
        RecordingDiskState.FINISHED,
        RecordingDiskState.UNPROCESSED,
        RecordingDiskState.NONEXISTENT,
    ]


def test_every_recording_in_the_home_directory_is_classified(tmp_path: Path):
    # and nothing else: a stray file is not a recording, and a symlink is not followed out of
    # the home directory
    home = tmp_path / "home"
    finish_recording(home, "DONE_2025")
    abandon_recording(home, "FAILED_2025")
    (home / "notes.txt").write_text("not a recording")
    finish_recording(tmp_path, "victim")
    (home / "link").symlink_to(tmp_path / "victim", target_is_directory=True)
    finish_recording(tmp_path / "elsewhere", "OTHER_2025")
    enclave = Enclave(digest_of("abc"), anyio.Path(home))

    infos = anyio.run(enclave.classify_all)

    assert sorted((info.name, info.disk_state) for info in infos) == [
        ("DONE_2025", RecordingDiskState.FINISHED),
        ("FAILED_2025", RecordingDiskState.UNPROCESSED),
    ]


def test_a_purge_forgets_the_recordings_otp(enclave: Enclave, tmp_path: Path):
    # a link from an old listing must not download a new recording of the same name
    finish_recording(tmp_path, "GVS_2025")
    otp = enclave.generate_totp("GVS_2025")

    with enclave.claim_purging("GVS_2025"):
        shutil.rmtree(tmp_path / "GVS_2025")

    assert not enclave.verify_totp(otp, "GVS_2025")


def test_a_purge_that_fails_keeps_the_recordings_otp(enclave: Enclave, tmp_path: Path):
    # the recording is still there, and the link in the listing still has to work
    finish_recording(tmp_path, "GVS_2025")
    otp = enclave.generate_totp("GVS_2025")

    with pytest.raises(OSError), enclave.claim_purging("GVS_2025"):
        raise OSError("busy")

    assert enclave.verify_totp(otp, "GVS_2025")
