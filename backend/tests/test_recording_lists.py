"""
The dependencies that sort a user's recordings into the lists the frontend shows: finished
recordings with a download OTP each, and recordings whose postprocessing failed, was never
scheduled, or was lost to a restart.

Everything here calls the dependencies directly. What the listing endpoint makes of them --
the response shape, authentication, the rendering list -- lives in test_server.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from pathlib import Path

import pytest

from ise_record.download_totp import DownloadTotpAuthority
from ise_record.recording_lists import (
    _get_downloadable_recording_paths, # pyright: ignore[reportPrivateUsage]
    get_downloadable_recordings,
    get_unprocessed_recordings,
)
from ise_record.settings import OidcSettings, Settings

from .harness import (
    abandon_recording,
    age,
    finish_recording,
    MINUTE,
    write_chunks,
)

@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    # the dependency only asks whether authentication is on; nothing here talks to a provider
    return Settings(destdir=tmp_path, oidc=OidcSettings(provider_url="https://idp.example.edu", audience="ise"))


@pytest.fixture
def home(tmp_path: Path) -> Path:
    user_home = tmp_path / "home"
    user_home.mkdir()
    return user_home


def unprocessed(settings: Settings, home: Path, running_jobs: frozenset[Path] | None = None) -> list[str]:
    return [ p.name for p in get_unprocessed_recordings(settings, home, running_jobs or frozenset[Path]()) ]


# --- unprocessed: what counts --------------------------------------------

def test_an_abandoned_recording_is_unprocessed(settings: Settings, home: Path):
    abandon_recording(home, "GVS_2025")

    assert unprocessed(settings, home) == [ "GVS_2025" ]


def test_a_recording_that_is_still_being_streamed_is_not_unprocessed(settings: Settings, home: Path):
    # an hour-long lecture in progress: its first chunks are long past the cutoff, but the
    # newest one was written seconds ago. Judging by the oldest chunk would put a Rerender
    # button on a lecture that is still going, and pressing it would render half of it.
    write_chunks(home / "LIVE_2026", [ 60 * MINUTE, 30 * MINUTE, 10 * MINUTE, 5 ])

    assert unprocessed(settings, home) == []


def test_the_newest_chunk_is_picked_by_name_not_by_listing_order(settings: Settings, home: Path):
    # chunk names are zero-padded to a fixed width, which is what makes the name order the
    # arrival order; this pins that the newest is picked by name and not by listing order
    track_dir = home / "LONG_2026" / "stream"
    track_dir.mkdir(parents=True)

    for index, seconds in [ (0, 60 * MINUTE), (9998, 20 * MINUTE), (9999, 5) ]:
        chunk = track_dir / f"chunk.{index:04d}"
        chunk.write_bytes(b"chunk")
        age(chunk, seconds)

    assert unprocessed(settings, home) == []


@pytest.mark.parametrize(("minutes", "listed"), [
    (1, False),
    (4, False),
    (6, True),
    (24 * 60, True),
])
def test_a_recording_is_given_up_on_five_minutes_after_its_last_chunk(
    settings: Settings, home: Path, minutes: float, listed: bool
):
    # chunks arrive every five seconds and a failed upload is retried for about twenty, so
    # five minutes of silence is well past anything a live lecture produces
    write_chunks(home / "GVS_2025", [ minutes * MINUTE ])

    assert unprocessed(settings, home) == ([ "GVS_2025" ] if listed else [])


def test_a_failed_render_left_behind_is_unprocessed(settings: Settings, home: Path):
    # the case the feature is mostly for: ffmpeg ran and failed, and its partial output is
    # kept for inspection -- which must not be mistaken for the finished file
    recording_dir = abandon_recording(home, "GVS_2025")
    (recording_dir / "presentation.part.webm").write_bytes(b"half")

    assert unprocessed(settings, home) == [ "GVS_2025" ]


def test_a_concatenation_left_behind_does_not_count_as_a_fresh_chunk(settings: Settings, home: Path):
    # concat_chunks writes full.webm into the stream directory itself, and a crash in the
    # middle of it leaves the file there. It sorts after chunk.*, and it is newer than any
    # chunk, so reading it as the newest chunk would hide the recording for five minutes
    # after every attempt.
    recording_dir = abandon_recording(home, "GVS_2025")
    (recording_dir / "stream" / "full.webm").write_bytes(b"concatenated")

    assert unprocessed(settings, home) == [ "GVS_2025" ]


def test_the_listing_is_sorted_by_name(settings: Settings, home: Path):
    for name in [ "PSU_2026", "ABC_2026", "GVS_2025" ]:
        abandon_recording(home, name)

    assert unprocessed(settings, home) == [ "ABC_2026", "GVS_2025", "PSU_2026" ]


# --- unprocessed: what is left out -----------------------------------------

def test_a_rendered_recording_is_not_unprocessed(settings: Settings, home: Path):
    recording_dir = abandon_recording(home, "GVS_2025")
    finish_recording(home, "GVS_2025")

    assert (recording_dir / "presentation.webm").exists()
    assert unprocessed(settings, home) == []


def test_a_recording_that_is_rendering_is_not_unprocessed(settings: Settings, home: Path):
    # its chunks are as old as an abandoned recording's, since the job starts once the
    # lecture ends; only the running job tells them apart
    recording_dir = abandon_recording(home, "GVS_2025")
    abandon_recording(home, "PSU_2026")

    assert unprocessed(settings, home, frozenset({ recording_dir })) == [ "PSU_2026" ]


def test_a_recording_without_a_main_stream_is_not_unprocessed(settings: Settings, home: Path):
    # postprocessing gives up on these with MAIN_STREAM_MISSING, so a Rerender button would
    # only ever fail again
    write_chunks(home / "GVS_2025", [ 30 * MINUTE ], track="overlay")

    assert unprocessed(settings, home) == []


def test_a_recording_with_an_empty_main_stream_is_not_unprocessed(settings: Settings, home: Path):
    # the directory is created before the first chunk is written to it
    (home / "GVS_2025" / "stream").mkdir(parents=True)

    assert unprocessed(settings, home) == []


def test_a_main_stream_with_only_a_leftover_concatenation_is_not_unprocessed(settings: Settings, home: Path):
    stream_dir = home / "GVS_2025" / "stream"
    stream_dir.mkdir(parents=True)
    (stream_dir / "full.webm").write_bytes(b"concatenated")
    age(stream_dir / "full.webm", 30 * MINUTE)

    assert unprocessed(settings, home) == []


def test_stray_files_in_the_home_directory_are_ignored(settings: Settings, home: Path):
    abandon_recording(home, "GVS_2025")
    (home / "notes.txt").write_text("not a recording")

    assert unprocessed(settings, home) == [ "GVS_2025" ]


def test_nothing_is_scanned_without_authentication(tmp_path: Path):
    # without authentication the "home" is the shared destination directory; the listing is
    # refused there anyway, and walking every lecture on the server for it would be waste
    abandon_recording(tmp_path, "GVS_2025")

    assert unprocessed(Settings(destdir=tmp_path), tmp_path) == []


# --- downloadable ----------------------------------------------------------

# The listing is built in two steps: a scan of the home directory that runs in the thread
# pool, and the OTPs minted on the event loop afterwards, because the authority's generators
# are shared state. The first step is private, but it is where every rule about which
# recordings are offered lives.

def downloadable(settings: Settings, home: Path) -> list[tuple[str, int]]:
    return [ (p.name, size) for p, size in _get_downloadable_recording_paths(settings, home) ]


def test_a_rendered_recording_is_downloadable_with_the_size_of_its_video(settings: Settings, home: Path):
    # the size of the video, which is what the download button shows -- not of the
    # recording directory that holds it
    finish_recording(home, "GVS_2025", b"x" * 12345)

    assert downloadable(settings, home) == [ ("GVS_2025", 12345) ]


def test_recordings_that_are_not_rendered_are_not_downloadable(settings: Settings, home: Path):
    finish_recording(home, "rendered")
    # uploaded but never postprocessed
    write_chunks(home / "raw", [ 30 * MINUTE ])
    # postprocessing that failed partway, which is left on disk deliberately
    (home / "failed").mkdir()
    (home / "failed" / "presentation.part.webm").write_bytes(b"half")

    assert [ name for name, _ in downloadable(settings, home) ] == [ "rendered" ]


def test_the_downloadable_recordings_are_sorted_by_name(settings: Settings, home: Path):
    for name in [ "PSU_2026", "ABC_2026", "GVS_2025" ]:
        finish_recording(home, name)

    assert [ name for name, _ in downloadable(settings, home) ] == [ "ABC_2026", "GVS_2025", "PSU_2026" ]


def test_stray_files_are_not_downloadable(settings: Settings, home: Path):
    finish_recording(home, "GVS_2025")
    (home / "notes.txt").write_text("not a recording")

    assert [ name for name, _ in downloadable(settings, home) ] == [ "GVS_2025" ]


@pytest.mark.asyncio
async def test_every_downloadable_recording_gets_an_otp_for_its_own_video(settings: Settings, home: Path):
    finish_recording(home, "GVS_2025")
    finish_recording(home, "PSU_2026", b"the other lecture")
    authority = DownloadTotpAuthority()

    listed = await get_downloadable_recordings(_get_downloadable_recording_paths(settings, home), authority)

    assert [ (r.name, r.size) for r in listed ] == [ ("GVS_2025", 5), ("PSU_2026", 17) ]
    # the OTP is for the file the download route will serve, which it assembles from the
    # recording name plus presentation.webm -- a key for the directory would never verify
    assert authority.verify(listed[0].totp, home / "GVS_2025" / "presentation.webm")
    assert authority.verify(listed[1].totp, home / "PSU_2026" / "presentation.webm")
    assert not authority.verify(listed[0].totp, home / "PSU_2026" / "presentation.webm")


def test_nothing_is_offered_for_download_without_authentication(tmp_path: Path):
    # without authentication the "home" is the shared destination directory, which holds
    # every lecture on the server; the listing is refused there, and the dependency runs
    # before that refusal
    finish_recording(tmp_path, "GVS_2025")

    assert downloadable(Settings(destdir=tmp_path), tmp_path) == []


@pytest.mark.asyncio
async def test_an_unauthenticated_deployment_mints_nothing(tmp_path: Path):
    # moved here from test_download_totp.py: an OTP generator for every lecture on the
    # server, for a response that hands none of them out, would be pure waste
    finish_recording(tmp_path, "GVS_2025")
    authority = DownloadTotpAuthority()

    await get_downloadable_recordings(_get_downloadable_recording_paths(Settings(destdir=tmp_path), tmp_path), authority)

    assert not authority.factories
