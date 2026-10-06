"""
The glue between the enclave and the endpoints: turning an enclave's recordings into the
listing's response, and purging a recording once it is safe to.

What the claims allow alongside each other, and how a recording's disk state, activity and
liveness are found out, is core.recordings' business, in tests/core/test_recordings.py. The
listing projects the three onto the one state the frontend shows for each recording, and that
projection is pinned here. What the endpoints make of it -- status codes on the wire,
authentication -- lives in test_server.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from pathlib import Path
import shutil
from urllib.parse import parse_qs, unquote, urlsplit

import anyio
from fastapi import HTTPException
import pytest
from pytest_mock import MockerFixture

from ise_record.core.auth import UserInfo
from ise_record.core.recordings import (
    RecordingActivity,
    RecordingDiskState,
    RecordingInfo,
)
from ise_record.glue.enclave import Enclave
from ise_record.glue.models import DownloadableRecording, RecordingResponse
from ise_record.glue.recordings import purge_recording, user_recordings_list

from ..harness import (
    abandon_recording,
    digest_of,
    finish_recording,
    MINUTE,
    write_chunks,
)

LECTURER = UserInfo(sub="lecturer-sub", preferred_username="lecturer")
DIGEST = digest_of("lecturer-sub")


@pytest.fixture
def home(tmp_path: Path) -> Path:
    user_home = tmp_path / "home"
    user_home.mkdir()
    return user_home


@pytest.fixture
def enclave(home: Path) -> Enclave:
    return Enclave(DIGEST, anyio.Path(home))


def states(listing: list[RecordingResponse]) -> list[tuple[str, str]]:
    return [(r.state, r.name) for r in listing]


def completed(listing: list[RecordingResponse]) -> list[DownloadableRecording]:
    return [r for r in listing if isinstance(r, DownloadableRecording)]


def link_parts(download_url: str) -> tuple[list[str], str]:
    """The path segments of a download link, decoded, and the OTP it carries."""
    link = urlsplit(download_url)
    return [unquote(segment) for segment in link.path.split("/")], parse_qs(link.query)["totp"][0]


# --- the listing's response ------------------------------------------------


@pytest.mark.asyncio
async def test_every_recording_is_listed_with_its_state(enclave: Enclave, home: Path):
    finish_recording(home, "DONE_2025", b"twelve bytes")
    abandon_recording(home, "FAILED_2025")
    abandon_recording(home, "BUSY_2025")

    with enclave.claim_rendering("BUSY_2025"):
        listing = await user_recordings_list(enclave)

    assert states(listing) == [
        ("rendering", "BUSY_2025"),
        ("completed", "DONE_2025"),
        ("unprocessed", "FAILED_2025"),
    ]
    assert [r.size for r in completed(listing)] == [12]
    # only the name for the others: nothing to size or download yet, and the Rerender button
    # needs no more
    assert {
        r.name: set(r.model_dump()) for r in listing if not isinstance(r, DownloadableRecording)
    } == {"BUSY_2025": {"state", "name"}, "FAILED_2025": {"state", "name"}}


@pytest.mark.asyncio
async def test_an_empty_home_directory_lists_nothing(enclave: Enclave):
    assert await user_recordings_list(enclave) == []


@pytest.mark.asyncio
async def test_the_listing_is_in_name_order(enclave: Enclave, home: Path):
    # the frontend renders the cards as they come, so without the sort they would appear in
    # whatever order the filesystem hands them out
    for name in ["PSU_2026", "ABC_2026", "XYZ_2024", "GVS_2025", "MMM_2025"]:
        finish_recording(home, name)

    listing = await user_recordings_list(enclave)

    assert [r.name for r in listing] == ["ABC_2026", "GVS_2025", "MMM_2025", "PSU_2026", "XYZ_2024"]


@pytest.mark.asyncio
async def test_the_listing_only_counts_the_enclaves_own_jobs(home: Path, tmp_path: Path):
    # another enclave's job on a recording of the same name changes nothing here
    abandon_recording(home, "FAILED_2025")
    elsewhere = Enclave(digest_of("someone-else"), anyio.Path(tmp_path / "elsewhere"))

    with elsewhere.claim_rendering("FAILED_2025"):
        listing = await user_recordings_list(Enclave(DIGEST, anyio.Path(home)))

    assert states(listing) == [("unprocessed", "FAILED_2025")]


# --- which state a recording is shown in --------------------------------------


@pytest.mark.asyncio
async def test_a_rerender_is_listed_as_rendering_rather_than_completed(
    enclave: Enclave, home: Path
):
    # the previous output stays on disk until the new one replaces it. Listed as completed,
    # it would be offered for download and for purging while ffmpeg works on it.
    abandon_recording(home, "GVS_2025")
    finish_recording(home, "GVS_2025")

    with enclave.claim_rendering("GVS_2025"):
        listing = await user_recordings_list(enclave)

    assert states(listing) == [("rendering", "GVS_2025")]


@pytest.mark.asyncio
async def test_a_recording_being_purged_is_left_out(
    mocker: MockerFixture, enclave: Enclave, home: Path
):
    # the frontend removed its card the moment the purge was confirmed; listing it again
    # would bring the card back until the purge is done
    finish_recording(home, "GONE_2025")
    abandon_recording(home, "FAILED_2025")
    finish_recording(home, "KEPT_2025")
    issued = mocker.spy(enclave, "generate_totp")

    with enclave.claim_purging("GONE_2025"), enclave.claim_purging("FAILED_2025"):
        listing = await user_recordings_list(enclave)

    assert states(listing) == [("completed", "KEPT_2025")]
    # and no OTP is handed out for a file that is on its way out
    assert [call.args for call in issued.call_args_list] == [("KEPT_2025",)]


@pytest.mark.asyncio
async def test_a_recording_that_is_still_streamed_is_not_offered_for_rerendering(
    enclave: Enclave, home: Path
):
    # Rerender and Purge on a lecture that is still going would be the wrong buttons
    write_chunks(home / "LIVE_2026", [5])

    assert await user_recordings_list(enclave) == []


@pytest.mark.asyncio
async def test_a_recording_receiving_a_chunk_right_now_is_not_offered_for_rerendering(
    enclave: Enclave, home: Path
):
    abandon_recording(home, "GVS_2025")

    with enclave.claim_upload("GVS_2025"):
        listing = await user_recordings_list(enclave)

    assert listing == []


@pytest.mark.asyncio
async def test_recordings_the_frontend_has_no_card_for_are_left_out(
    enclave: Enclave, home: Path, tmp_path: Path
):
    write_chunks(home / "NO_MAIN_2025", [30 * MINUTE], track="overlay")
    (home / "notes.txt").write_text("not a recording")
    finish_recording(tmp_path, "victim")
    (home / "link").symlink_to(tmp_path / "victim", target_is_directory=True)

    assert await user_recordings_list(enclave) == []


@pytest.mark.asyncio
async def test_an_open_deployment_lists_nothing(home: Path):
    # there is nobody to hand a download link to, and a link naming no user would lead nowhere;
    # the endpoint refuses the listing there anyway
    finish_recording(home, "DONE_2025")
    abandon_recording(home, "FAILED_2025")

    assert await user_recordings_list(Enclave(None, anyio.Path(home))) == []


# --- the download links -------------------------------------------------------


@pytest.mark.asyncio
async def test_every_completed_recording_gets_a_link_with_an_otp_for_itself(
    enclave: Enclave, home: Path
):
    finish_recording(home, "GVS_2025")
    finish_recording(home, "PSU_2026")

    links = [link_parts(r.download_url) for r in completed(await user_recordings_list(enclave))]

    # relative to the API root, so the server need not know where it is reachable; the digest
    # is how the download route finds the enclave without a token, and the OTP is checked
    # against the recording named next to it
    assert [segments for segments, _ in links] == [
        ["downloads", DIGEST, "GVS_2025"],
        ["downloads", DIGEST, "PSU_2026"],
    ]
    (_, gvs_otp), (_, psu_otp) = links
    assert enclave.verify_totp(gvs_otp, "GVS_2025")
    assert enclave.verify_totp(psu_otp, "PSU_2026")
    assert not enclave.verify_totp(gvs_otp, "PSU_2026")


@pytest.mark.asyncio
async def test_a_name_that_is_special_in_a_url_is_encoded_in_the_link(enclave: Enclave, home: Path):
    # left as it is, the # would cut the link short, and the ? would start the query early
    finish_recording(home, "Übung #3?_2025")

    (recording,) = completed(await user_recordings_list(enclave))

    segments, otp = link_parts(recording.download_url)
    assert segments == ["downloads", DIGEST, "Übung #3?_2025"]
    assert enclave.verify_totp(otp, "Übung #3?_2025")


@pytest.mark.asyncio
async def test_the_otps_come_from_the_enclaves_own_authority(enclave: Enclave, home: Path):
    # the download route looks the authority up by the digest in the link, so an OTP issued
    # anywhere else would never verify
    finish_recording(home, "GVS_2025")
    elsewhere = Enclave(digest_of("someone-else"), anyio.Path(home))

    (recording,) = completed(await user_recordings_list(enclave))

    _, otp = link_parts(recording.download_url)
    assert enclave.verify_totp(otp, "GVS_2025")
    assert not elsewhere.verify_totp(otp, "GVS_2025")


@pytest.mark.asyncio
async def test_the_listing_does_not_go_back_to_the_disk(
    mocker: MockerFixture, enclave: Enclave, home: Path
):
    # the size comes from the scan. Reading it again afterwards would fail for a recording
    # that another tab purged since -- turning the whole listing into a 500.
    mocker.patch.object(
        enclave,
        "classify_all",
        return_value=[
            RecordingInfo(
                path=anyio.Path(home / "PURGED_2025"),
                activity=RecordingActivity.NONE,
                disk_state=RecordingDiskState.FINISHED,
                streaming=False,
                size=12345,
            )
        ],
    )

    listing = await user_recordings_list(enclave)

    assert [(r.name, r.size) for r in completed(listing)] == [("PURGED_2025", 12345)]


@pytest.mark.asyncio
async def test_rendering_and_unprocessed_recordings_get_no_otp(
    mocker: MockerFixture, enclave: Enclave, home: Path
):
    abandon_recording(home, "FAILED_2025")
    abandon_recording(home, "BUSY_2025")
    issued = mocker.spy(enclave, "generate_totp")

    with enclave.claim_rendering("BUSY_2025"):
        await user_recordings_list(enclave)

    issued.assert_not_called()


# --- purging ---------------------------------------------------------------


async def refusal(enclave: Enclave, recording: str, user_info: UserInfo | None = LECTURER) -> int:
    with pytest.raises(HTTPException) as refused:
        await purge_recording(recording, enclave, user_info)

    return refused.value.status_code


@pytest.mark.asyncio
async def test_a_finished_recording_is_purged(enclave: Enclave, home: Path):
    finish_recording(home, "DONE_2025")
    finish_recording(home, "OTHER_2025")

    await purge_recording("DONE_2025", enclave, LECTURER)

    assert not (home / "DONE_2025").exists()
    assert (home / "OTHER_2025").exists()


@pytest.mark.asyncio
async def test_a_failed_recording_is_purged(enclave: Enclave, home: Path):
    abandon_recording(home, "FAILED_2025")

    await purge_recording("FAILED_2025", enclave, LECTURER)

    assert not (home / "FAILED_2025").exists()


@pytest.mark.asyncio
async def test_an_idle_recording_that_cannot_be_rendered_is_purged(enclave: Enclave, home: Path):
    # nothing will ever come of it, so getting rid of it is all that is left to do
    write_chunks(home / "NO_MAIN_2025", [30 * 60], track="overlay")

    await purge_recording("NO_MAIN_2025", enclave, LECTURER)

    assert not (home / "NO_MAIN_2025").exists()


@pytest.mark.asyncio
async def test_a_purge_forgets_the_recordings_otp(enclave: Enclave, home: Path):
    # a recording made again under the same name must not be downloadable with an OTP that
    # was handed out for the one that was purged
    finish_recording(home, "DONE_2025")
    otp = enclave.generate_totp("DONE_2025")

    await purge_recording("DONE_2025", enclave, LECTURER)

    assert not enclave.verify_totp(otp, "DONE_2025")


@pytest.mark.asyncio
async def test_a_recording_that_does_not_exist_is_a_404(enclave: Enclave):
    assert await refusal(enclave, "NEVER_2025") == 404


@pytest.mark.asyncio
async def test_a_stray_file_is_a_404_and_stays(enclave: Enclave, home: Path):
    (home / "notes.txt").write_text("not a recording")

    assert await refusal(enclave, "notes.txt") == 404
    assert (home / "notes.txt").exists()


@pytest.mark.asyncio
async def test_a_symlink_is_a_404_and_its_target_stays(
    enclave: Enclave, home: Path, tmp_path: Path
):
    # not a 409: "in use" would suggest trying again later
    finish_recording(tmp_path, "victim")
    (home / "link").symlink_to(tmp_path / "victim", target_is_directory=True)

    assert await refusal(enclave, "link") == 404
    assert (tmp_path / "victim" / "presentation.webm").exists()


@pytest.mark.asyncio
async def test_a_recording_that_is_rendering_is_a_409_and_stays(enclave: Enclave, home: Path):
    # deleting it would pull the chunks out from under ffmpeg
    abandon_recording(home, "BUSY_2025")

    with enclave.claim_rendering("BUSY_2025"):
        assert await refusal(enclave, "BUSY_2025") == 409

    assert (home / "BUSY_2025").exists()


@pytest.mark.asyncio
async def test_a_recording_that_is_being_rerendered_is_a_409(enclave: Enclave, home: Path):
    # finished by every other measure, since the previous output is still there
    abandon_recording(home, "BUSY_2025")
    finish_recording(home, "BUSY_2025")

    with enclave.claim_rendering("BUSY_2025"):
        assert await refusal(enclave, "BUSY_2025") == 409


@pytest.mark.asyncio
async def test_a_recording_receiving_a_chunk_right_now_is_a_409_and_stays(
    enclave: Enclave, home: Path
):
    # rmtree would take the directory apart around the file being written
    abandon_recording(home, "GVS_2025")

    with enclave.claim_upload("GVS_2025"):
        assert await refusal(enclave, "GVS_2025") == 409

    assert (home / "GVS_2025").exists()


@pytest.mark.asyncio
async def test_another_enclaves_job_does_not_block_a_purge(home: Path, tmp_path: Path):
    abandon_recording(home, "FAILED_2025")
    elsewhere = Enclave(digest_of("someone-else"), anyio.Path(tmp_path / "elsewhere"))

    with elsewhere.claim_rendering("FAILED_2025"):
        await purge_recording("FAILED_2025", Enclave(DIGEST, anyio.Path(home)), LECTURER)

    assert not (home / "FAILED_2025").exists()


@pytest.mark.asyncio
async def test_a_recording_that_is_still_being_streamed_is_a_409(enclave: Enclave, home: Path):
    # the next chunk would recreate the directory and bring back half a recording
    write_chunks(home / "LIVE_2026", [30 * 60, 5])

    assert await refusal(enclave, "LIVE_2026") == 409
    assert (home / "LIVE_2026").exists()


@pytest.mark.asyncio
async def test_a_live_recording_without_a_main_stream_yet_is_a_409(enclave: Enclave, home: Path):
    # the same, in the first seconds of a lecture whose overlay chunks arrive first: it is
    # not renderable yet, which on its own would let it be purged
    write_chunks(home / "LIVE_2026", [5], track="overlay")

    assert await refusal(enclave, "LIVE_2026") == 409
    assert (home / "LIVE_2026").exists()


@pytest.mark.asyncio
async def test_a_recording_whose_job_was_requested_is_no_longer_live(enclave: Enclave, home: Path):
    # the job request is the frontend saying the lecture is over, so the lecturer can purge
    # the recording straight away rather than wait out the grace period
    write_chunks(home / "GVS_2025", [30 * 60, 5])

    with enclave.claim_upload("GVS_2025"):
        pass
    with enclave.claim_rendering("GVS_2025"):
        pass

    await purge_recording("GVS_2025", enclave, LECTURER)

    assert not (home / "GVS_2025").exists()


@pytest.mark.asyncio
async def test_a_purge_without_a_user_is_a_401(enclave: Enclave, home: Path):
    # cannot happen behind the authentication check, which is what makes it worth a test:
    # without it, this would be an AttributeError on the log line and a 500
    finish_recording(home, "DONE_2025")

    assert await refusal(enclave, "DONE_2025", user_info=None) == 401
    assert (home / "DONE_2025").exists()


@pytest.mark.asyncio
async def test_a_filesystem_error_is_a_500_and_keeps_the_otp(
    mocker: MockerFixture, enclave: Enclave, home: Path
):
    # whatever is left of the recording may still be listed, and its link should still work
    finish_recording(home, "DONE_2025")
    otp = enclave.generate_totp("DONE_2025")
    mocker.patch("ise_record.glue.enclave.shutil.rmtree", side_effect=OSError("busy"))

    assert await refusal(enclave, "DONE_2025") == 500
    assert enclave.verify_totp(otp, "DONE_2025")


@pytest.mark.asyncio
async def test_a_purge_is_logged_with_the_user_who_asked(
    enclave: Enclave, home: Path, caplog: pytest.LogCaptureFixture
):
    finish_recording(home, "DONE_2025")

    with caplog.at_level("INFO", logger="ise_record"):
        await purge_recording("DONE_2025", enclave, LECTURER)

    assert any(
        "lecturer-sub" in r.getMessage() and "DONE_2025" in r.getMessage() for r in caplog.records
    )


# --- the purge's claim --------------------------------------------------------
#
# While the purge looks at the recording and while rmtree runs, the purge holds its claim,
# which is what turns away uploads, jobs and a second purge, and what keeps the listing from
# showing a half-deleted recording.


@pytest.mark.asyncio
async def test_the_recording_is_claimed_while_it_is_deleted(
    mocker: MockerFixture, enclave: Enclave, home: Path
):
    finish_recording(home, "DONE_2025")
    seen_while_deleting: list[RecordingActivity] = []
    real_rmtree = shutil.rmtree

    def watching_rmtree(path: Path) -> None:
        seen_while_deleting.append(enclave.activity("DONE_2025"))
        real_rmtree(path)

    mocker.patch("ise_record.glue.enclave.shutil.rmtree", side_effect=watching_rmtree)

    await purge_recording("DONE_2025", enclave, LECTURER)

    assert seen_while_deleting == [RecordingActivity.PURGING]


@pytest.mark.asyncio
@pytest.mark.parametrize("question", ["disk_state", "streaming"])
async def test_the_claim_is_taken_before_the_recording_is_looked_at(
    mocker: MockerFixture, enclave: Enclave, home: Path, question: str
):
    # looking at the recording awaits the filesystem, so a job or an upload can come in while
    # it does; whatever the purge finds out has to still hold when rmtree runs, which it only
    # does if nothing else could claim the recording in between
    finish_recording(home, "DONE_2025")
    seen_while_looking: list[RecordingActivity] = []
    real_question = getattr(enclave, question)

    async def watching(recording: str) -> object:
        seen_while_looking.append(enclave.activity(recording))
        return await real_question(recording)

    mocker.patch.object(enclave, question, side_effect=watching)

    await purge_recording("DONE_2025", enclave, LECTURER)

    assert seen_while_looking == [RecordingActivity.PURGING]


@pytest.mark.asyncio
async def test_the_claim_is_gone_once_the_purge_is_done(enclave: Enclave, home: Path):
    finish_recording(home, "DONE_2025")

    await purge_recording("DONE_2025", enclave, LECTURER)

    # a recording made again under the same name can be uploaded straight away
    assert enclave.activity("DONE_2025") == RecordingActivity.NONE


@pytest.mark.asyncio
@pytest.mark.parametrize("setup", ["nonexistent", "streaming"])
async def test_the_claim_is_gone_after_a_refusal(setup: str, enclave: Enclave, home: Path):
    # a refused purge must not leave the recording locked against uploads and jobs until the
    # server restarts
    if setup == "streaming":
        write_chunks(home / "GVS_2025", [5])

    with pytest.raises(HTTPException):
        await purge_recording("GVS_2025", enclave, LECTURER)

    assert enclave.activity("GVS_2025") == RecordingActivity.NONE


@pytest.mark.asyncio
async def test_the_claim_is_gone_after_a_filesystem_error(
    mocker: MockerFixture, enclave: Enclave, home: Path
):
    finish_recording(home, "DONE_2025")
    mocker.patch("ise_record.glue.enclave.shutil.rmtree", side_effect=OSError("busy"))

    with pytest.raises(HTTPException):
        await purge_recording("DONE_2025", enclave, LECTURER)

    assert enclave.activity("DONE_2025") == RecordingActivity.NONE


@pytest.mark.asyncio
async def test_another_recording_being_purged_does_not_block_a_purge(enclave: Enclave, home: Path):
    finish_recording(home, "DONE_2025")
    finish_recording(home, "GONE_2025")

    with enclave.claim_purging("GONE_2025"):
        await purge_recording("DONE_2025", enclave, LECTURER)

        assert enclave.activity("GONE_2025") == RecordingActivity.PURGING

    assert not (home / "DONE_2025").exists()
