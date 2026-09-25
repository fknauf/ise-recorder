"""
What state a recording on disk is in: still being streamed, being rendered, finished, given up
on, not renderable at all, or not a recording in the first place.

Nothing records most of these states, so they are read off the filesystem and the set of
running jobs. The listing and the purge endpoint both go through this classification, so a
mistake here shows up in both -- which recordings the lecturer is offered, and which ones a
purge is allowed to delete.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from pathlib import Path

import pytest

from ise_record.core.recordings import (
    classify_all_recordings,
    classify_recording,
    RecordingInfo,
    RecordingState,
)

from ..harness import (
    abandon_recording,
    age,
    finish_recording,
    MINUTE,
    write_chunks,
)

NO_JOBS = frozenset[Path]()


@pytest.fixture
def home(tmp_path: Path) -> Path:
    user_home = tmp_path / "home"
    user_home.mkdir()
    return user_home


def state_of(recording_dir: Path, running_jobs: frozenset[Path] = NO_JOBS) -> RecordingState:
    return classify_recording(recording_dir, running_jobs).state


# --- finished --------------------------------------------------------------

def test_a_rendered_recording_is_finished_with_the_size_of_its_video(home: Path):
    # the size of the video, which is what the download button shows -- not of the
    # recording directory that holds it
    finish_recording(home, "GVS_2025", b"x" * 12345)

    assert classify_recording(home / "GVS_2025", NO_JOBS) == RecordingInfo(
        path=home / "GVS_2025", state=RecordingState.FINISHED, size=12345
    )


def test_only_a_finished_recording_carries_a_size(home: Path):
    abandon_recording(home, "GVS_2025")

    assert classify_recording(home / "GVS_2025", NO_JOBS).size is None


# --- rendering -------------------------------------------------------------

def test_a_recording_with_a_job_in_flight_is_rendering(home: Path):
    # its chunks are as old as an abandoned recording's, since the job starts once the
    # lecture ends; only the running job tells them apart
    recording_dir = abandon_recording(home, "GVS_2025")

    assert state_of(recording_dir, frozenset({ recording_dir })) == RecordingState.RENDERING


def test_a_rerender_is_rendering_rather_than_finished(home: Path):
    # the previous output stays on disk until the new one replaces it. Classified as
    # finished, it would be offered for download and for purging while ffmpeg works on it.
    recording_dir = abandon_recording(home, "GVS_2025")
    finish_recording(home, "GVS_2025")

    assert state_of(recording_dir, frozenset({ recording_dir })) == RecordingState.RENDERING


def test_a_job_on_another_recording_changes_nothing(home: Path):
    finish_recording(home, "DONE_2025")

    assert state_of(home / "DONE_2025", frozenset({ home / "BUSY_2025" })) == RecordingState.FINISHED


# --- streaming or given up on ----------------------------------------------

def test_an_abandoned_recording_is_unprocessed(home: Path):
    assert state_of(abandon_recording(home, "GVS_2025")) == RecordingState.UNPROCESSED


def test_a_recording_that_is_still_being_streamed_is_streaming(home: Path):
    # an hour-long lecture in progress: its first chunks are long past the cutoff, but the
    # newest one was written seconds ago. Judging by the oldest chunk would put a Rerender
    # and a Purge button on a lecture that is still going.
    write_chunks(home / "LIVE_2026", [ 60 * MINUTE, 30 * MINUTE, 10 * MINUTE, 5 ])

    assert state_of(home / "LIVE_2026") == RecordingState.STREAMING


def test_the_newest_chunk_is_picked_by_name_not_by_listing_order(home: Path):
    # chunk names are zero-padded to a fixed width, which is what makes the name order the
    # arrival order
    track_dir = home / "LONG_2026" / "stream"
    track_dir.mkdir(parents=True)

    for index, seconds in [ (0, 60 * MINUTE), (9998, 20 * MINUTE), (9999, 5) ]:
        chunk = track_dir / f"chunk.{index:04d}"
        chunk.write_bytes(b"chunk")
        age(chunk, seconds)

    assert state_of(home / "LONG_2026") == RecordingState.STREAMING


@pytest.mark.parametrize(("minutes", "state"), [
    (1, RecordingState.STREAMING),
    (4, RecordingState.STREAMING),
    (6, RecordingState.UNPROCESSED),
    (24 * 60, RecordingState.UNPROCESSED),
])
def test_a_recording_is_given_up_on_five_minutes_after_its_last_chunk(home: Path, minutes: float, state: RecordingState):
    # chunks arrive every five seconds and a failed upload is retried for about twenty, so
    # five minutes of silence is well past anything a live lecture produces
    write_chunks(home / "GVS_2025", [ minutes * MINUTE ])

    assert state_of(home / "GVS_2025") == state


def test_a_failed_render_left_behind_is_unprocessed(home: Path):
    # the case the Rerender button is mostly for: ffmpeg ran and failed, and its partial
    # output is kept for inspection -- which must not be mistaken for the finished file
    recording_dir = abandon_recording(home, "GVS_2025")
    (recording_dir / "presentation.part.webm").write_bytes(b"half")

    assert state_of(recording_dir) == RecordingState.UNPROCESSED


def test_a_concatenation_left_behind_does_not_count_as_a_fresh_chunk(home: Path):
    # concat_chunks writes full.webm into the stream directory itself, and a crash in the
    # middle of it leaves the file there. It sorts after chunk.* and is newer than any
    # chunk, so reading it as the newest chunk would keep the recording "streaming".
    recording_dir = abandon_recording(home, "GVS_2025")
    (recording_dir / "stream" / "full.webm").write_bytes(b"concatenated")

    assert state_of(recording_dir) == RecordingState.UNPROCESSED


# --- not renderable --------------------------------------------------------

def test_a_recording_without_a_main_stream_is_not_renderable(home: Path):
    # postprocessing gives up on these with MAIN_STREAM_MISSING, so a Rerender button would
    # only ever fail again
    write_chunks(home / "GVS_2025", [ 30 * MINUTE ], track="overlay")

    assert state_of(home / "GVS_2025") == RecordingState.NOT_RENDERABLE


def test_a_live_recording_without_a_main_stream_yet_is_not_renderable(home: Path):
    # the first seconds of a lecture, if its overlay chunks arrive before the main track's.
    # Not unprocessed, however fresh or stale -- the purge endpoint relies on that to keep
    # its hands off a recording whose next chunk would bring it straight back.
    write_chunks(home / "LIVE_2026", [ 5 ], track="overlay")

    assert state_of(home / "LIVE_2026") == RecordingState.NOT_RENDERABLE


def test_a_recording_with_an_empty_main_stream_is_not_renderable(home: Path):
    # the directory is created just before the first chunk is written into it
    (home / "GVS_2025" / "stream").mkdir(parents=True)

    assert state_of(home / "GVS_2025") == RecordingState.NOT_RENDERABLE


def test_a_main_stream_with_only_a_leftover_concatenation_is_not_renderable(home: Path):
    stream_dir = home / "GVS_2025" / "stream"
    stream_dir.mkdir(parents=True)
    (stream_dir / "full.webm").write_bytes(b"concatenated")
    age(stream_dir / "full.webm", 30 * MINUTE)

    assert state_of(home / "GVS_2025") == RecordingState.NOT_RENDERABLE


def test_an_output_that_is_not_a_file_is_not_renderable(home: Path):
    # rendering would have to write presentation.webm where something else already is
    recording_dir = abandon_recording(home, "GVS_2025")
    (recording_dir / "presentation.webm").mkdir()

    assert state_of(recording_dir) == RecordingState.NOT_RENDERABLE


# --- not a recording -------------------------------------------------------

def test_a_missing_directory_is_nonexistent(home: Path):
    assert state_of(home / "never_recorded") == RecordingState.NONEXISTENT


def test_a_stray_file_is_nonexistent(home: Path):
    (home / "notes.txt").write_text("not a recording")

    assert state_of(home / "notes.txt") == RecordingState.NONEXISTENT


def test_a_symlink_is_not_followed(home: Path, tmp_path: Path):
    # nothing in the app creates one, but if one turns up in a home directory it must not
    # be classified by what it points at: as finished it would be listed for download and
    # offered for purging, with the listing and the purge acting on its target
    finish_recording(tmp_path, "victim")
    (home / "link").symlink_to(tmp_path / "victim", target_is_directory=True)

    assert state_of(home / "link") == RecordingState.NONEXISTENT


# --- every recording at once -----------------------------------------------

def test_every_entry_of_the_home_directory_is_classified_in_name_order(home: Path):
    # the listing renders them as they come, so without the sort the cards would appear in
    # whatever order the filesystem hands them out
    for name in [ "PSU_2026", "ABC_2026", "XYZ_2024", "GVS_2025", "MMM_2025" ]:
        finish_recording(home, name)

    assert [ r.path.name for r in classify_all_recordings(home, NO_JOBS) ] == [ "ABC_2026", "GVS_2025", "MMM_2025", "PSU_2026", "XYZ_2024" ]


def test_every_entry_gets_its_own_state(home: Path):
    finish_recording(home, "DONE_2025")
    abandon_recording(home, "FAILED_2025")
    busy = abandon_recording(home, "BUSY_2025")
    write_chunks(home / "LIVE_2026", [ 5 ])
    (home / "notes.txt").write_text("not a recording")

    assert { r.path.name: r.state for r in classify_all_recordings(home, frozenset({ busy })) } == {
        "BUSY_2025": RecordingState.RENDERING,
        "DONE_2025": RecordingState.FINISHED,
        "FAILED_2025": RecordingState.UNPROCESSED,
        "LIVE_2026": RecordingState.STREAMING,
        "notes.txt": RecordingState.NONEXISTENT,
    }


def test_an_empty_home_directory_has_no_recordings(home: Path):
    assert not classify_all_recordings(home, NO_JOBS)
