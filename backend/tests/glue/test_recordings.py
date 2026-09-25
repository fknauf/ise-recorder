"""
The dependables between the classification of recordings and the endpoints: sorting a user's
recordings into the lists the frontend shows, turning those into the listing's response, and
deciding whether a purge may go ahead.

Which state a recording is in is core.recordings' business, in tests/core/test_recordings.py;
these pin what the glue does with it. What the endpoints make of it -- status codes on the
wire, authentication, the files that are actually deleted -- lives in test_server.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from pathlib import Path

from fastapi import HTTPException
import pytest

from ise_record.core.auth import DownloadTotpAuthority, UserInfo
from ise_record.core.recordings import RecordingInfo, RecordingState
from ise_record.glue.models import DisplayableRecording, RecordingsList
from ise_record.glue.recordings import (
    get_classified_recordings,
    get_recording_path_for_purge,
    get_recordings_list,
    RecordingClasses,
)
from ise_record.settings import Settings

from ..harness import (
    abandon_recording,
    finish_recording,
    write_chunks,
)

NO_JOBS = frozenset[Path]()
LECTURER = UserInfo(sub="lecturer-sub", preferred_username="lecturer")


@pytest.fixture
def home(tmp_path: Path) -> Path:
    user_home = tmp_path / "home"
    user_home.mkdir()
    return user_home


def names(recordings: list[RecordingInfo]) -> list[str]:
    return [ r.path.name for r in recordings ]


# --- sorting into lists ----------------------------------------------------

def test_each_recording_lands_in_the_list_for_its_state(settings: Settings, home: Path):
    finish_recording(home, "DONE_2025")
    abandon_recording(home, "FAILED_2025")
    busy = abandon_recording(home, "BUSY_2025")

    classes = get_classified_recordings(settings, home, frozenset({ busy }))

    assert names(classes.finished) == [ "DONE_2025" ]
    assert names(classes.rendering) == [ "BUSY_2025" ]
    assert names(classes.unprocessed) == [ "FAILED_2025" ]


def test_an_empty_home_directory_gives_three_empty_lists(settings: Settings, home: Path):
    # every list is looked up whether or not anything landed in it
    assert get_classified_recordings(settings, home, NO_JOBS) == RecordingClasses([], [], [])


def test_recordings_the_frontend_has_no_card_for_are_left_out(settings: Settings, home: Path, tmp_path: Path):
    write_chunks(home / "LIVE_2026", [ 5 ])
    write_chunks(home / "NO_MAIN_2025", [ 30 * 60 ], track="overlay")
    (home / "notes.txt").write_text("not a recording")
    finish_recording(tmp_path, "victim")
    (home / "link").symlink_to(tmp_path / "victim", target_is_directory=True)

    assert get_classified_recordings(settings, home, NO_JOBS) == RecordingClasses([], [], [])


def test_each_list_keeps_the_name_order(settings: Settings, home: Path):
    for name in [ "PSU_2026", "ABC_2026", "GVS_2025" ]:
        finish_recording(home, name)
        abandon_recording(home, f"FAILED_{name}")

    classes = get_classified_recordings(settings, home, NO_JOBS)

    assert names(classes.finished) == [ "ABC_2026", "GVS_2025", "PSU_2026" ]
    assert names(classes.unprocessed) == [ "FAILED_ABC_2026", "FAILED_GVS_2025", "FAILED_PSU_2026" ]


def test_nothing_is_scanned_without_authentication(open_settings: Settings):
    # without authentication the "home" is the shared destination directory, which holds
    # every lecture on the server; the listing is refused there, and this runs before that
    finish_recording(open_settings.destdir, "DONE_2025")
    abandon_recording(open_settings.destdir, "FAILED_2025")

    assert get_classified_recordings(open_settings, open_settings.destdir, NO_JOBS) == RecordingClasses([], [], [])


# --- the listing's response ------------------------------------------------

@pytest.mark.asyncio
async def test_the_listing_names_the_user_directory_and_every_recording(home: Path):
    classes = RecordingClasses(
        finished=[ RecordingInfo(home / "DONE_2025", RecordingState.FINISHED, 12345) ],
        rendering=[ RecordingInfo(home / "BUSY_2025", RecordingState.RENDERING) ],
        unprocessed=[ RecordingInfo(home / "FAILED_2025", RecordingState.UNPROCESSED) ],
    )

    listing = await get_recordings_list(classes, DownloadTotpAuthority(), home)

    assert isinstance(listing, RecordingsList)
    # the user directory is what the download links have to name, not the display name
    assert listing.user == "home"
    assert [ (r.name, r.size) for r in listing.completed ] == [ ("DONE_2025", 12345) ]
    # only the name: nothing to size or download yet, and the Rerender button needs no more
    assert listing.rendering == [ DisplayableRecording(name="BUSY_2025") ]
    assert listing.unprocessed == [ DisplayableRecording(name="FAILED_2025") ]


@pytest.mark.asyncio
async def test_every_finished_recording_gets_an_otp_for_its_own_video(home: Path):
    classes = RecordingClasses(
        finished=[
            RecordingInfo(home / "GVS_2025", RecordingState.FINISHED, 5),
            RecordingInfo(home / "PSU_2026", RecordingState.FINISHED, 17),
        ],
        rendering=[],
        unprocessed=[],
    )
    authority = DownloadTotpAuthority()

    listing = await get_recordings_list(classes, authority, home)

    # the OTP is for the file the download route will serve, which it assembles from the
    # recording name plus presentation.webm -- a key for the directory would never verify
    assert authority.verify(listing.completed[0].totp, home / "GVS_2025" / "presentation.webm")
    assert authority.verify(listing.completed[1].totp, home / "PSU_2026" / "presentation.webm")
    assert not authority.verify(listing.completed[0].totp, home / "PSU_2026" / "presentation.webm")


@pytest.mark.asyncio
async def test_the_listing_does_not_go_back_to_the_disk(home: Path):
    # the size comes from the scan. Reading it again here, on the event loop, would fail for
    # a recording that another tab purged since -- turning the whole listing into a 500.
    classes = RecordingClasses(
        finished=[ RecordingInfo(home / "PURGED_2025", RecordingState.FINISHED, 12345) ],
        rendering=[],
        unprocessed=[],
    )

    listing = await get_recordings_list(classes, DownloadTotpAuthority(), home)

    assert [ (r.name, r.size) for r in listing.completed ] == [ ("PURGED_2025", 12345) ]


@pytest.mark.asyncio
async def test_rendering_and_unprocessed_recordings_get_no_otp(home: Path):
    classes = RecordingClasses(
        finished=[],
        rendering=[ RecordingInfo(home / "BUSY_2025", RecordingState.RENDERING) ],
        unprocessed=[ RecordingInfo(home / "FAILED_2025", RecordingState.UNPROCESSED) ],
    )
    authority = DownloadTotpAuthority()

    await get_recordings_list(classes, authority, home)

    assert not authority.factories


# --- whether a purge may go ahead ------------------------------------------

def purge_path(home: Path, recording: str, running_jobs: frozenset[Path] = NO_JOBS, user_info: UserInfo | None = LECTURER) -> Path:
    return get_recording_path_for_purge(recording, user_info, home, running_jobs)


def refusal(home: Path, recording: str, running_jobs: frozenset[Path] = NO_JOBS, user_info: UserInfo | None = LECTURER) -> int:
    with pytest.raises(HTTPException) as refused:
        purge_path(home, recording, running_jobs, user_info)

    return refused.value.status_code


def test_a_finished_recording_may_be_purged(home: Path):
    finish_recording(home, "DONE_2025")

    assert purge_path(home, "DONE_2025") == home / "DONE_2025"


def test_a_failed_recording_may_be_purged(home: Path):
    abandon_recording(home, "FAILED_2025")

    assert purge_path(home, "FAILED_2025") == home / "FAILED_2025"


def test_a_recording_that_does_not_exist_is_a_404(home: Path):
    assert refusal(home, "NEVER_2025") == 404


def test_a_stray_file_is_a_404(home: Path):
    (home / "notes.txt").write_text("not a recording")

    assert refusal(home, "notes.txt") == 404


def test_a_symlink_is_a_404(home: Path, tmp_path: Path):
    # not a 409: "in use" would suggest trying again later
    finish_recording(tmp_path, "victim")
    (home / "link").symlink_to(tmp_path / "victim", target_is_directory=True)

    assert refusal(home, "link") == 404


def test_a_recording_that_is_rendering_is_a_409(home: Path):
    # deleting it would pull the chunks out from under ffmpeg
    recording_dir = abandon_recording(home, "BUSY_2025")

    assert refusal(home, "BUSY_2025", frozenset({ recording_dir })) == 409


def test_a_recording_that_is_being_rerendered_is_a_409(home: Path):
    # finished by every other measure, since the previous output is still there
    recording_dir = abandon_recording(home, "BUSY_2025")
    finish_recording(home, "BUSY_2025")

    assert refusal(home, "BUSY_2025", frozenset({ recording_dir })) == 409


def test_a_recording_that_is_still_being_streamed_is_a_409(home: Path):
    # the next chunk would recreate the directory and bring back half a recording
    write_chunks(home / "LIVE_2026", [ 30 * 60, 5 ])

    assert refusal(home, "LIVE_2026") == 409


def test_a_live_recording_without_a_main_stream_yet_is_a_409(home: Path):
    # the same, in the first seconds of a lecture whose overlay chunks arrive first
    write_chunks(home / "LIVE_2026", [ 5 ], track="overlay")

    assert refusal(home, "LIVE_2026") == 409


def test_a_purge_without_a_user_is_a_401(home: Path):
    # cannot happen behind the authentication check, which is what makes it worth a test:
    # without it, this would be an AttributeError on the log line and a 500
    finish_recording(home, "DONE_2025")

    assert refusal(home, "DONE_2025", user_info=None) == 401


def test_a_purge_is_logged_with_the_user_who_asked(home: Path, caplog: pytest.LogCaptureFixture):
    finish_recording(home, "DONE_2025")

    with caplog.at_level("INFO", logger="ise_record"):
        purge_path(home, "DONE_2025")

    assert any("lecturer-sub" in r.getMessage() and "DONE_2025" in r.getMessage() for r in caplog.records)
