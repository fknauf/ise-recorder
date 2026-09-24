"""
Recordings whose postprocessing failed, was never scheduled, or was lost to a restart.

Nothing records that a job failed, so these are recognized from what is on disk: a main
stream with chunks, no rendered output, no job in flight -- and no chunk arriving any more,
because a lecture that is still being streamed looks exactly the same otherwise. The last
condition is the fragile one and gets most of the tests below.

The first half calls the dependency directly, with chunk ages set through os.utime; the
second half goes through the listing endpoint for what the frontend actually receives.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

import os
from pathlib import Path
import time
from typing import cast

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from ise_record.server import get_unprocessed_recordings
from ise_record.settings import OidcSettings, Settings

from .harness import (
    DEFAULT_SUBJECT_DIGEST,
    digest_of,
    finish_recording,
    list_recordings,
    Provider,
)

MINUTE = 60


def age(path: Path, seconds: float) -> None:
    """ Backdate a file's modification time, which is what the staleness check reads. """
    then = time.time() - seconds
    os.utime(path, (then, then))


def write_chunks(recording_dir: Path, ages: list[float], track: str = "stream") -> None:
    """ One chunk per entry, chunk.0000 first, each last written `age` seconds ago. """
    track_dir = recording_dir / track
    track_dir.mkdir(parents=True, exist_ok=True)

    for index, seconds in enumerate(ages):
        chunk = track_dir / f"chunk.{index:04d}"
        chunk.write_bytes(b"chunk")
        age(chunk, seconds)


def abandoned(home: Path, name: str, minutes: float = 30) -> Path:
    """ A recording whose last chunk arrived long enough ago that nobody is streaming it. """
    recording_dir = home / name
    write_chunks(recording_dir, [ (minutes + 2) * MINUTE, (minutes + 1) * MINUTE, minutes * MINUTE ])
    return recording_dir


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    # the dependency only asks whether authentication is on; nothing here talks to a provider
    return Settings(destdir=tmp_path, oidc=OidcSettings(provider_url="https://idp.example.edu", audience="ise"))


@pytest.fixture
def home(tmp_path: Path) -> Path:
    user_home = tmp_path / "home"
    user_home.mkdir()
    return user_home


def unprocessed(settings: Settings, home: Path, running_jobs: set[Path] | None = None) -> list[str]:
    return [ p.name for p in get_unprocessed_recordings(settings, home, running_jobs or set()) ]


# --- what counts as unprocessed --------------------------------------------

def test_an_abandoned_recording_is_unprocessed(settings: Settings, home: Path):
    abandoned(home, "GVS_2025")

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
    recording_dir = abandoned(home, "GVS_2025")
    (recording_dir / "presentation.part.webm").write_bytes(b"half")

    assert unprocessed(settings, home) == [ "GVS_2025" ]


def test_a_concatenation_left_behind_does_not_count_as_a_fresh_chunk(settings: Settings, home: Path):
    # concat_chunks writes full.webm into the stream directory itself, and a crash in the
    # middle of it leaves the file there. It sorts after chunk.*, and it is newer than any
    # chunk, so reading it as the newest chunk would hide the recording for five minutes
    # after every attempt.
    recording_dir = abandoned(home, "GVS_2025")
    (recording_dir / "stream" / "full.webm").write_bytes(b"concatenated")

    assert unprocessed(settings, home) == [ "GVS_2025" ]


def test_the_listing_is_sorted_by_name(settings: Settings, home: Path):
    for name in [ "PSU_2026", "ABC_2026", "GVS_2025" ]:
        abandoned(home, name)

    assert unprocessed(settings, home) == [ "ABC_2026", "GVS_2025", "PSU_2026" ]


# --- what is left out ------------------------------------------------------

def test_a_rendered_recording_is_not_unprocessed(settings: Settings, home: Path):
    recording_dir = abandoned(home, "GVS_2025")
    finish_recording(home, "GVS_2025")

    assert (recording_dir / "presentation.webm").exists()
    assert unprocessed(settings, home) == []


def test_a_recording_that_is_rendering_is_not_unprocessed(settings: Settings, home: Path):
    # its chunks are as old as an abandoned recording's, since the job starts once the
    # lecture ends; only the running job tells them apart
    recording_dir = abandoned(home, "GVS_2025")
    abandoned(home, "PSU_2026")

    assert unprocessed(settings, home, { recording_dir }) == [ "PSU_2026" ]


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
    abandoned(home, "GVS_2025")
    (home / "notes.txt").write_text("not a recording")

    assert unprocessed(settings, home) == [ "GVS_2025" ]


def test_nothing_is_scanned_without_authentication(tmp_path: Path):
    # without authentication the "home" is the shared destination directory; the listing is
    # refused there anyway, and walking every lecture on the server for it would be waste
    abandoned(tmp_path, "GVS_2025")

    assert unprocessed(Settings(destdir=tmp_path), tmp_path) == []


# --- through the listing endpoint ------------------------------------------

def running_jobs_of(auth_client: TestClient, home: Path) -> set[Path]:
    app = cast(FastAPI, auth_client.app)
    return app.state.per_user_running_jobs[home]


def test_the_listing_reports_unprocessed_recordings_by_name(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "DONE_2025")
    abandoned(home, "GVS_2025")

    data = list_recordings(auth_client, provider.mint()).json()

    # only the name: there is nothing to download, and the Rerender button needs no more
    assert data["unprocessed"] == [ { "name": "GVS_2025" } ]
    assert [ r["name"] for r in data["completed"] ] == [ "DONE_2025" ]
    assert data["rendering"] == []


def test_the_listing_reports_no_unprocessed_recordings_when_there_are_none(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "DONE_2025")

    # present and empty rather than absent, because the frontend schema requires the field
    assert list_recordings(auth_client, provider.mint()).json()["unprocessed"] == []


def test_the_listing_only_shows_the_callers_own_unprocessed_recordings(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    abandoned(tmp_path / digest_of("user-a"), "mine")
    abandoned(tmp_path / digest_of("user-b"), "theirs")

    assert list_recordings(auth_client, provider.mint(sub="user-a")).json()["unprocessed"] == [ { "name": "mine" } ]
    assert list_recordings(auth_client, provider.mint(sub="user-b")).json()["unprocessed"] == [ { "name": "theirs" } ]


def test_a_rerendered_recording_moves_from_unprocessed_to_rendering(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # what the lecturer sees after pressing Rerender on a failed card: the card turns into
    # a spinner rather than showing up twice
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    recording_dir = abandoned(home, "GVS_2025")
    token = provider.mint()

    assert list_recordings(auth_client, token).json()["unprocessed"] == [ { "name": "GVS_2025" } ]

    running_jobs_of(auth_client, home).add(recording_dir)
    data = list_recordings(auth_client, token).json()

    assert data["unprocessed"] == []
    assert data["rendering"] == [ { "name": "GVS_2025" } ]
