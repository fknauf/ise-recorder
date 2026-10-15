"""
What the server knows about a recording, along three separate lines:

- its disk state: finished, renderable but unprocessed, not renderable, or not there at all --
  read off the filesystem;
- its activity: whether a render, a purge, chunk uploads or raw-data downloads have claimed it
  -- kept in memory, and taken and released through the claims, which are what keep two of
  those from running over each other;
- its liveness: whether it still looks like it is being streamed -- a guess from when its last
  chunk arrived, since nothing tells the server that a lecture has ended.

The listing projects the three onto the state the frontend shows for each recording; the
endpoints ask the line they care about directly. Both are in glue/test_recordings.py and
test_server.py.

And the raw-data download: the zip archive of a recording's chunks, streamed as it is written.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from collections.abc import Callable
from contextlib import AbstractContextManager, ExitStack, nullcontext
from datetime import datetime, timedelta
from io import BytesIO
from itertools import product
import os
from pathlib import Path
import shutil
from zipfile import ZIP_STORED, ZipFile

import anyio
import pytest
from pytest_mock import MockerFixture

from ise_record.core import recordings
from ise_record.core.recordings import (
    classify_disk_state,
    raw_download_zipstream,
    RecordingActivity,
    RecordingBusy,
    RecordingDiskState,
    RecordingInfo,
    RecordingTracker,
    STREAMING_GRACE_PERIOD,
)

from ..harness import (
    abandon_recording,
    age,
    finish_recording,
    MINUTE,
    recording_dir,
    stray,
    write_chunks,
)


@pytest.fixture
def home(tmp_path: Path) -> Path:
    user_home = tmp_path / "home"
    user_home.mkdir()
    return user_home


def recording(home: Path, name: str) -> anyio.Path:
    """The path the tracker is handed for a recording: an anyio one, as the enclave builds it."""
    return anyio.Path(recording_dir(home, name))


def disk_state_of(path: Path) -> RecordingDiskState:
    state, _ = anyio.run(classify_disk_state, anyio.Path(path))
    return state


def is_streaming(tracker: RecordingTracker, path: Path) -> bool:
    return anyio.run(tracker.streaming, anyio.Path(path))


class Clock:  # pylint: disable=too-few-public-methods
    """How far the tracker's idea of now has been moved past the real one."""

    def __init__(self) -> None:
        self.offset = timedelta()

    def advance(self, delta: timedelta) -> None:
        self.offset += delta


@pytest.fixture
def clock(mocker: MockerFixture) -> Clock:
    """
    Lets a test move the tracker's clock forward. The in-memory record of the last upload is
    taken from the clock, not from the disk, so backdating a file does nothing for it.
    """
    shifted = Clock()

    class ShiftedDatetime(datetime):
        """datetime, with now() moved forward by however far the test has advanced the clock"""

        @classmethod
        def now(cls, tz=None):  # type: ignore[override]
            return datetime.now(tz) + shifted.offset

    mocker.patch("ise_record.core.recordings.datetime", ShiftedDatetime)
    return shifted


# --- disk state: finished --------------------------------------------------


def test_a_rendered_recording_is_finished_with_the_size_of_its_video(home: Path):
    # the size of the video, which is what the download button shows -- not of the
    # recording directory that holds it
    finish_recording(home, "GVS_2025", b"x" * 12345)

    assert anyio.run(classify_disk_state, recording(home, "GVS_2025")) == (
        RecordingDiskState.FINISHED,
        12345,
    )


def test_only_a_finished_recording_carries_a_size(home: Path):
    abandon_recording(home, "GVS_2025")

    assert anyio.run(classify_disk_state, recording(home, "GVS_2025"))[1] is None


# --- disk state: renderable, but not rendered ------------------------------


def test_an_abandoned_recording_is_unprocessed(home: Path):
    assert disk_state_of(abandon_recording(home, "GVS_2025")) == RecordingDiskState.UNPROCESSED


def test_a_recording_still_receiving_chunks_is_unprocessed_on_disk(home: Path):
    # whether it is still being streamed is the liveness line's business; on disk it is a
    # renderable recording like any other
    write_chunks(recording_dir(home, "LIVE_2026"), [5])

    assert disk_state_of(recording_dir(home, "LIVE_2026")) == RecordingDiskState.UNPROCESSED


def test_a_failed_render_left_behind_is_unprocessed(home: Path):
    # the case the Rerender button is mostly for: ffmpeg ran and failed, and its partial
    # output is kept for inspection -- which must not be mistaken for the finished file
    recording_path = abandon_recording(home, "GVS_2025")
    (recording_path / "presentation.part.webm").write_bytes(b"half")

    assert disk_state_of(recording_path) == RecordingDiskState.UNPROCESSED


def test_a_concatenation_left_behind_is_still_unprocessed(home: Path):
    # concat_chunks writes full.webm into the stream directory itself, and a crash in the
    # middle of it leaves the file there next to the chunks it was made from
    recording_path = abandon_recording(home, "GVS_2025")
    (recording_path / "stream" / "full.webm").write_bytes(b"concatenated")

    assert disk_state_of(recording_path) == RecordingDiskState.UNPROCESSED


# --- disk state: not renderable --------------------------------------------


def test_a_recording_without_a_main_stream_is_not_renderable(home: Path):
    # postprocessing gives up on these with MAIN_STREAM_MISSING, so a Rerender button would
    # only ever fail again
    write_chunks(recording_dir(home, "GVS_2025"), [30 * MINUTE], track="overlay")

    assert disk_state_of(recording_dir(home, "GVS_2025")) == RecordingDiskState.NOT_RENDERABLE


def test_chunks_in_another_track_do_not_make_up_for_an_empty_main_stream(home: Path):
    # the overlay and audio tracks are layered onto the main stream; without it there is
    # nothing to render, however many chunks the other tracks hold
    (recording_dir(home, "GVS_2025") / "stream").mkdir(parents=True)
    write_chunks(recording_dir(home, "GVS_2025"), [30 * MINUTE], track="overlay")
    write_chunks(recording_dir(home, "GVS_2025"), [30 * MINUTE], track="audio-0")

    assert disk_state_of(recording_dir(home, "GVS_2025")) == RecordingDiskState.NOT_RENDERABLE


def test_a_recording_with_an_empty_main_stream_is_not_renderable(home: Path):
    # the directory is created just before the first chunk is written into it
    (recording_dir(home, "GVS_2025") / "stream").mkdir(parents=True)

    assert disk_state_of(recording_dir(home, "GVS_2025")) == RecordingDiskState.NOT_RENDERABLE


def test_a_main_stream_with_only_a_leftover_concatenation_is_not_renderable(home: Path):
    stream_dir = recording_dir(home, "GVS_2025") / "stream"
    stream_dir.mkdir(parents=True)
    (stream_dir / "full.webm").write_bytes(b"concatenated")

    assert disk_state_of(recording_dir(home, "GVS_2025")) == RecordingDiskState.NOT_RENDERABLE


def test_a_main_stream_with_only_a_partial_chunk_is_not_renderable(home: Path):
    # an upload writes to part.chunk.* and renames it once it is complete; a part file left
    # by an upload that broke off is not a chunk
    stream_dir = recording_dir(home, "GVS_2025") / "stream"
    stream_dir.mkdir(parents=True)
    (stream_dir / "part.chunk.0000").write_bytes(b"half a chunk")

    assert disk_state_of(recording_dir(home, "GVS_2025")) == RecordingDiskState.NOT_RENDERABLE


def test_an_output_that_is_not_a_file_is_not_renderable(home: Path):
    # rendering would have to write presentation.webm where something else already is
    recording_path = abandon_recording(home, "GVS_2025")
    (recording_path / "presentation.webm").mkdir()

    assert disk_state_of(recording_path) == RecordingDiskState.NOT_RENDERABLE


# --- disk state: not a recording -------------------------------------------


def test_a_missing_directory_is_nonexistent(home: Path):
    assert disk_state_of(recording_dir(home, "never_recorded")) == RecordingDiskState.NONEXISTENT


def test_a_stray_file_is_nonexistent(home: Path):
    stray(home, "notes.txt").write_text("not a recording", encoding="utf-8")

    assert disk_state_of(recording_dir(home, "notes.txt")) == RecordingDiskState.NONEXISTENT


def test_a_symlink_is_not_followed(home: Path, tmp_path: Path):
    # nothing in the app creates one, but if one turns up in a home directory it must not
    # be classified by what it points at: as finished it would be listed for download and
    # offered for purging, with the listing and the purge acting on its target
    victim = finish_recording(tmp_path, "victim")
    stray(home, "link").symlink_to(victim, target_is_directory=True)

    assert disk_state_of(recording_dir(home, "link")) == RecordingDiskState.NONEXISTENT


# --- activity: the claims ---------------------------------------------------

Claim = Callable[[RecordingTracker, anyio.Path], AbstractContextManager[object]]

CLAIMS = [
    pytest.param(RecordingTracker.claim_rendering, RecordingActivity.RENDERING, id="rendering"),
    pytest.param(RecordingTracker.claim_purging, RecordingActivity.PURGING, id="purging"),
    pytest.param(RecordingTracker.claim_uploading, RecordingActivity.UPLOADING, id="uploading"),
    pytest.param(RecordingTracker.claim_zipping, RecordingActivity.ZIPPING, id="zipping"),
]


def test_nothing_is_busy_by_default(home: Path):
    assert RecordingTracker().activity(recording(home, "GVS_2025")) == RecordingActivity.NONE


@pytest.mark.parametrize("claim, activity", CLAIMS)
def test_a_claim_holds_the_recording_for_as_long_as_it_is_entered(
    home: Path, claim: Claim, activity: RecordingActivity
):
    tracker = RecordingTracker()

    with claim(tracker, recording(home, "foo")):
        assert tracker.activity(recording(home, "foo")) == activity

    assert tracker.activity(recording(home, "foo")) == RecordingActivity.NONE


@pytest.mark.parametrize("claim, activity", CLAIMS)
def test_a_claim_is_released_when_its_work_blows_up(
    home: Path, claim: Claim, activity: RecordingActivity
):
    # otherwise one unexpected failure locks that recording out until the server is restarted:
    # a render that never ends as far as the listing can tell, or a purge that never lets go
    tracker = RecordingTracker()

    with pytest.raises(RuntimeError), claim(tracker, recording(home, "foo")):
        assert tracker.activity(recording(home, "foo")) == activity
        raise RuntimeError("boom")

    assert tracker.activity(recording(home, "foo")) == RecordingActivity.NONE


@pytest.mark.parametrize("claim, activity", CLAIMS)
def test_a_claim_leaves_other_recordings_alone(
    home: Path, claim: Claim, activity: RecordingActivity
):
    tracker = RecordingTracker()

    with claim(tracker, recording(home, "bar")):
        with claim(tracker, recording(home, "foo")):
            pass

        assert tracker.activity(recording(home, "foo")) == RecordingActivity.NONE
        assert tracker.activity(recording(home, "bar")) == activity


@pytest.mark.parametrize("claim, activity", CLAIMS)
def test_another_trackers_claim_on_a_recording_of_the_same_name_changes_nothing(
    tmp_path: Path, claim: Claim, activity: RecordingActivity
):
    # one tracker per enclave: two lecturers naming a lecture alike is ordinary
    elsewhere, here = RecordingTracker(), RecordingTracker()

    with claim(elsewhere, recording(tmp_path / "a", "foo")):
        assert elsewhere.activity(recording(tmp_path / "a", "foo")) == activity
        assert here.activity(recording(tmp_path / "b", "foo")) == RecordingActivity.NONE


# What may run alongside what. A purge needs the recording to itself: it would take the files
# away from under anything else, and a chunk would land in a directory rmtree is taking apart,
# or bring it back. A render may not run beside a second one, which would write over its files,
# nor start while a chunk is still being written, since it would read the track before the
# chunk is in. Chunks may arrive while it runs, though: a chunk that is refused may be gone for
# good, while a render that missed it can be repeated, and the upload writes it under a name
# the render does not read until it is complete. A raw-data download reads only complete
# chunks, which nothing but a purge takes away, so it goes alongside anything else.

CLAIM_FOR: dict[RecordingActivity, Claim] = {
    RecordingActivity.RENDERING: RecordingTracker.claim_rendering,
    RecordingActivity.PURGING: RecordingTracker.claim_purging,
    RecordingActivity.UPLOADING: RecordingTracker.claim_uploading,
    RecordingActivity.ZIPPING: RecordingTracker.claim_zipping,
}

RENDERING = RecordingActivity.RENDERING
PURGING = RecordingActivity.PURGING
UPLOADING = RecordingActivity.UPLOADING
ZIPPING = RecordingActivity.ZIPPING

# the first claim holding the recording, and the second one asking for it
REFUSED = [
    (PURGING, PURGING),
    (PURGING, RENDERING),
    (PURGING, UPLOADING),
    (PURGING, ZIPPING),
    (RENDERING, PURGING),
    (UPLOADING, PURGING),
    (ZIPPING, PURGING),
    (RENDERING, RENDERING),
    (UPLOADING, RENDERING),
]

# the same, and which activity the recording shows while both hold it: the one that matters
# most to the listing and to the claims that come after
ALONGSIDE = [
    (RENDERING, UPLOADING, RENDERING),
    (RENDERING, ZIPPING, RENDERING),
    (ZIPPING, RENDERING, RENDERING),
    (UPLOADING, UPLOADING, UPLOADING),
    (UPLOADING, ZIPPING, UPLOADING),
    (ZIPPING, UPLOADING, UPLOADING),
    (ZIPPING, ZIPPING, ZIPPING),
]


def pair_id(holding: RecordingActivity, claiming: RecordingActivity) -> str:
    return f"{claiming.name.lower()}-while-{holding.name.lower()}"


def test_every_pair_of_claims_is_decided():
    # an activity added later has to be placed against every other one, not just the ones
    # someone thought of
    decided = REFUSED + [(holding, claiming) for holding, claiming, _ in ALONGSIDE]

    assert sorted(decided, key=str) == sorted(product(CLAIM_FOR, repeat=2), key=str)


@pytest.mark.parametrize(
    "holding, claiming", [pytest.param(*pair, id=pair_id(*pair)) for pair in REFUSED]
)
def test_a_claim_that_conflicts_with_the_one_holding_the_recording_is_refused(
    home: Path, holding: RecordingActivity, claiming: RecordingActivity
):
    tracker = RecordingTracker()

    with CLAIM_FOR[holding](tracker, recording(home, "foo")):
        with (
            pytest.raises(RecordingBusy) as excinfo,
            CLAIM_FOR[claiming](tracker, recording(home, "foo")),
        ):
            pytest.fail("claimed a recording that was already claimed")

        # the refusal says what is in the way
        assert excinfo.value.state == holding
        # and the claim that was there first keeps the recording
        assert tracker.activity(recording(home, "foo")) == holding

    # nor does the refusal leave anything behind: once the first claim is done, the recording
    # is free, and the claim that was refused goes through
    assert tracker.activity(recording(home, "foo")) == RecordingActivity.NONE
    assert not tracker.activities

    with CLAIM_FOR[claiming](tracker, recording(home, "foo")):
        assert tracker.activity(recording(home, "foo")) == claiming


@pytest.mark.parametrize(
    "holding, claiming, shown",
    [pytest.param(*case, id=pair_id(*case[:2])) for case in ALONGSIDE],
)
def test_a_claim_that_does_not_conflict_runs_alongside_the_one_holding_the_recording(
    home: Path,
    holding: RecordingActivity,
    claiming: RecordingActivity,
    shown: RecordingActivity,
):
    tracker = RecordingTracker()

    with CLAIM_FOR[holding](tracker, recording(home, "foo")):
        with CLAIM_FOR[claiming](tracker, recording(home, "foo")):
            assert tracker.activity(recording(home, "foo")) == shown

        # the second one done is not the first one done
        assert tracker.activity(recording(home, "foo")) == holding

    assert tracker.activity(recording(home, "foo")) == RecordingActivity.NONE


def test_uploads_run_alongside_each_other(home: Path):
    # the frontend uploads its tracks' chunks in parallel, and retries overlap with new ones
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "foo")):
        with tracker.claim_uploading(recording(home, "foo")):
            assert tracker.activity(recording(home, "foo")) == RecordingActivity.UPLOADING

        # one of them done is not all of them done: a purge must still wait
        assert tracker.activity(recording(home, "foo")) == RecordingActivity.UPLOADING

    assert tracker.activity(recording(home, "foo")) == RecordingActivity.NONE


@pytest.mark.parametrize(
    "claim", [CLAIM_FOR[UPLOADING], CLAIM_FOR[ZIPPING]], ids=["uploads", "zips"]
)
def test_a_purge_waits_for_the_last_of_several_claims_that_run_alongside_each_other(
    home: Path, claim: Claim
):
    # two tabs downloading the same recording, or two tracks uploading their chunks: the first
    # to finish must not let a purge take the directory away from under the other
    tracker = RecordingTracker()

    with claim(tracker, recording(home, "foo")):
        with claim(tracker, recording(home, "foo")):
            pass

        with pytest.raises(RecordingBusy), tracker.claim_purging(recording(home, "foo")):
            pytest.fail("purged a recording that was still claimed")

    with tracker.claim_purging(recording(home, "foo")):
        assert tracker.activity(recording(home, "foo")) == RecordingActivity.PURGING


def test_the_activity_shown_is_the_weightiest_claim_still_held(home: Path):
    # The listing reads this one activity: a render hides every other, a chunk arriving hides
    # the card, and a download changes nothing about it. The claims are let go of in another
    # order than they were taken, as requests that overlap do.
    tracker = RecordingTracker()
    render, download, chunk = ExitStack(), ExitStack(), ExitStack()
    seen: list[RecordingActivity] = []

    render.enter_context(tracker.claim_rendering(recording(home, "foo")))
    download.enter_context(tracker.claim_zipping(recording(home, "foo")))
    chunk.enter_context(tracker.claim_uploading(recording(home, "foo")))

    for claim in [render, chunk, download]:
        seen.append(tracker.activity(recording(home, "foo")))
        claim.close()
    seen.append(tracker.activity(recording(home, "foo")))

    assert seen == [
        RecordingActivity.RENDERING,
        RecordingActivity.UPLOADING,
        RecordingActivity.ZIPPING,
        RecordingActivity.NONE,
    ]


@pytest.mark.parametrize("blows_up", [False, True], ids=["done", "blown-up"])
@pytest.mark.parametrize("claim, activity", CLAIMS)
def test_the_tracker_keeps_nothing_on_a_recording_nobody_holds(
    home: Path, claim: Claim, activity: RecordingActivity, blows_up: bool
):
    # every chunk of every lecture takes a claim, so whatever the tracker kept per claim would
    # grow for as long as the server runs
    tracker = RecordingTracker()

    with (
        pytest.raises(RuntimeError) if blows_up else nullcontext(),
        claim(tracker, recording(home, "foo")),
    ):
        assert tracker.activity(recording(home, "foo")) == activity
        if blows_up:
            raise RuntimeError("boom")

    assert not tracker.activities


def test_a_failed_upload_does_not_hold_the_recording(home: Path):
    tracker = RecordingTracker()

    with pytest.raises(OSError), tracker.claim_uploading(recording(home, "foo")):
        raise OSError("disk full")

    assert tracker.activity(recording(home, "foo")) == RecordingActivity.NONE


# --- liveness ----------------------------------------------------------------
#
# A recording counts as streamed while a chunk arrived within the grace period and no job was
# requested since. The tests below are written against STREAMING_GRACE_PERIOD rather than a
# number of minutes, so that tuning it does not mean rewriting them.

GRACE_SECONDS = STREAMING_GRACE_PERIOD.total_seconds()


def test_an_upload_makes_a_recording_live(home: Path):
    # whatever its chunks on disk say -- these are half an hour old
    abandon_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass

    assert is_streaming(tracker, recording_dir(home, "GVS_2025"))


def test_a_recording_stops_being_live_once_the_grace_period_has_passed(home: Path, clock: Clock):
    write_chunks(recording_dir(home, "GVS_2025"), [5])
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass
    clock.advance(STREAMING_GRACE_PERIOD - timedelta(seconds=10))

    assert is_streaming(tracker, recording_dir(home, "GVS_2025"))

    clock.advance(timedelta(seconds=20))

    assert not is_streaming(tracker, recording_dir(home, "GVS_2025"))


def test_a_failed_upload_is_not_a_sign_of_life(home: Path):
    abandon_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    with pytest.raises(OSError), tracker.claim_uploading(recording(home, "GVS_2025")):
        raise OSError("disk full")

    assert not is_streaming(tracker, recording_dir(home, "GVS_2025"))


def test_a_job_request_ends_the_stream(home: Path):
    # the frontend asks for the render once the lecture is over, so that is the end of it,
    # with no need to wait out the grace period
    write_chunks(recording_dir(home, "GVS_2025"), [5])
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass
    with tracker.claim_rendering(recording(home, "GVS_2025")):
        pass

    assert not is_streaming(tracker, recording_dir(home, "GVS_2025"))


def test_a_chunk_after_the_job_makes_the_recording_live_again(home: Path):
    write_chunks(recording_dir(home, "GVS_2025"), [5])
    tracker = RecordingTracker()

    with tracker.claim_rendering(recording(home, "GVS_2025")):
        pass
    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass

    assert is_streaming(tracker, recording_dir(home, "GVS_2025"))


def test_a_job_refused_by_the_tracker_does_not_end_the_stream(home: Path):
    # it never got as far as claiming the recording: a purge was in the way. The purge then
    # fails too, as a purge refused after all does, so that it forgets nothing either.
    abandon_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass
    with pytest.raises(RuntimeError), tracker.claim_purging(recording(home, "GVS_2025")):
        with pytest.raises(RecordingBusy), tracker.claim_rendering(recording(home, "GVS_2025")):
            pass
        raise RuntimeError("the purge is refused after all")

    assert is_streaming(tracker, recording_dir(home, "GVS_2025"))


# After a restart nothing is in memory, so the newest chunk on disk stands in for the last
# upload. Without it, every recording would look idle right after a deploy -- including the
# one being streamed at that moment, which would then be offered for purging.


@pytest.mark.parametrize(
    ("fraction", "streaming"),
    [(0.1, True), (0.9, True), (1.1, False), (100, False)],
)
def test_after_a_restart_the_newest_chunk_on_disk_stands_in_for_the_last_upload(
    home: Path, fraction: float, streaming: bool
):
    write_chunks(recording_dir(home, "GVS_2025"), [fraction * GRACE_SECONDS])

    assert is_streaming(RecordingTracker(), recording_dir(home, "GVS_2025")) == streaming


def test_after_a_restart_a_lecture_in_progress_is_judged_by_its_newest_chunk(home: Path):
    # an hour-long lecture in progress: its first chunks are long past the cutoff, but the
    # newest one was written seconds ago
    write_chunks(recording_dir(home, "LIVE_2026"), [60 * MINUTE, 30 * MINUTE, 10 * MINUTE, 5])

    assert is_streaming(RecordingTracker(), recording_dir(home, "LIVE_2026"))


def test_the_newest_chunk_is_picked_by_name_not_by_listing_order(home: Path):
    # chunk names are zero-padded to a fixed width, which is what makes the name order the
    # arrival order
    track_dir = recording_dir(home, "LONG_2026") / "stream"
    track_dir.mkdir(parents=True)

    for index, seconds in [(0, 60 * MINUTE), (9998, 20 * MINUTE), (9999, 5)]:
        chunk = track_dir / f"chunk.{index:04d}"
        chunk.write_bytes(b"chunk")
        age(chunk, seconds)

    assert is_streaming(RecordingTracker(), recording_dir(home, "LONG_2026"))


def test_after_a_restart_a_fresh_chunk_in_any_track_counts(home: Path):
    # the first seconds of a lecture, if its overlay chunks arrive before the main track's:
    # not renderable yet, but certainly live, and not to be purged from under the streamer
    write_chunks(recording_dir(home, "LIVE_2026"), [5], track="overlay")

    assert is_streaming(RecordingTracker(), recording_dir(home, "LIVE_2026"))


def test_after_a_restart_a_track_without_chunks_does_not_hide_the_others(home: Path):
    # an upload that broke off before its first chunk was in leaves a track directory holding
    # nothing that counts as a chunk; the recording is still judged by the tracks that do
    # have some, rather than the listing falling over
    write_chunks(recording_dir(home, "LIVE_2026"), [5])
    empty_track = recording_dir(home, "LIVE_2026") / "overlay"
    empty_track.mkdir()
    (empty_track / "part.chunk.0000.k2x9q1zb").write_bytes(b"half a chunk")

    assert is_streaming(RecordingTracker(), recording_dir(home, "LIVE_2026"))


def test_a_concatenation_left_behind_is_not_a_fresh_chunk(home: Path):
    # concat_chunks writes full.webm into the stream directory, after every chunk
    recording_path = abandon_recording(home, "GVS_2025")
    (recording_path / "stream" / "full.webm").write_bytes(b"concatenated")

    assert not is_streaming(RecordingTracker(), recording_path)


@pytest.mark.parametrize("name", ["never_recorded", "notes.txt", "link"])
def test_something_that_is_not_a_recording_is_not_live(home: Path, tmp_path: Path, name: str):
    # and asking does not fail: the listing asks about everything in the home directory
    stray(home, "notes.txt").write_text("not a recording", encoding="utf-8")
    victim = recording_dir(tmp_path, "victim")
    write_chunks(victim, [5])
    stray(home, "link").symlink_to(victim, target_is_directory=True)

    assert not is_streaming(RecordingTracker(), recording_dir(home, name))


def test_a_look_at_the_disk_does_not_overwrite_an_upload_that_finished_meanwhile(
    mocker: MockerFixture, home: Path
):
    # The scan awaits the disk, so an upload can complete in the middle of it. What the scan
    # found is older than that upload, and recording it would make a live recording look
    # idle. The upload is made to land exactly there, in the middle of the scan.
    abandon_recording(home, "GVS_2025")
    tracker = RecordingTracker()
    real_scan = recordings._last_chunk_time_in_recording  # pyright: ignore[reportPrivateUsage]  # pylint: disable=protected-access

    async def scan_while_a_chunk_arrives(recording_path: anyio.Path) -> datetime | None:
        found = await real_scan(recording_path)
        with tracker.claim_uploading(recording_path):
            pass
        return found

    mocker.patch(
        "ise_record.core.recordings._last_chunk_time_in_recording",
        side_effect=scan_while_a_chunk_arrives,
    )

    assert is_streaming(tracker, recording_dir(home, "GVS_2025"))
    # and the record keeps the upload, which a second look finds without scanning
    assert is_streaming(tracker, recording_dir(home, "GVS_2025"))


# After a restart the render time is gone from memory as well. Without it, a recording whose
# job ran just before the restart would count as live for the rest of the grace period, since
# its chunks are as fresh as a lecture's in progress. What ffmpeg left on disk stands in for
# it: the output, or the intermediate file a render that broke off had started writing.


def test_after_a_restart_a_recording_rendered_since_its_last_chunk_is_not_live(home: Path):
    write_chunks(recording_dir(home, "GVS_2025"), [30, 20])
    finish_recording(home, "GVS_2025")

    assert not is_streaming(RecordingTracker(), recording_dir(home, "GVS_2025"))


def test_after_a_restart_a_render_that_broke_off_counts_as_the_end_of_the_stream(home: Path):
    # the job was requested, so the lecture was over; ffmpeg had got as far as writing
    write_chunks(recording_dir(home, "GVS_2025"), [30, 20])
    (recording_dir(home, "GVS_2025") / "presentation.part.webm").write_bytes(b"half a video")

    assert not is_streaming(RecordingTracker(), recording_dir(home, "GVS_2025"))


def test_after_a_restart_a_render_that_left_nothing_on_disk_does_not_end_the_stream(home: Path):
    # the accepted gap: a job that broke off before ffmpeg wrote anything leaves no trace, so
    # the recording counts as live until the grace period is over
    write_chunks(recording_dir(home, "GVS_2025"), [30, 20])

    assert is_streaming(RecordingTracker(), recording_dir(home, "GVS_2025"))


def test_after_a_restart_chunks_newer_than_the_last_render_are_live(home: Path):
    # a lecture streamed again under the name of an old one, whose output is still there
    finish_recording(home, "GVS_2025")
    age(recording_dir(home, "GVS_2025") / "presentation.webm", 60 * MINUTE)
    write_chunks(recording_dir(home, "GVS_2025"), [5])

    assert is_streaming(RecordingTracker(), recording_dir(home, "GVS_2025"))


def test_a_look_at_the_disk_does_not_overwrite_a_job_requested_meanwhile(
    mocker: MockerFixture, home: Path
):
    # the same race as for the upload: the estimate awaits the disk, and a job requested in
    # the middle of it is newer than anything the estimate can find
    finish_recording(home, "GVS_2025")
    age(recording_dir(home, "GVS_2025") / "presentation.webm", 60 * MINUTE)
    write_chunks(recording_dir(home, "GVS_2025"), [5])
    tracker = RecordingTracker()
    real_estimate = recordings._estimate_render_time_from_disk  # pyright: ignore[reportPrivateUsage]  # pylint: disable=protected-access

    async def estimate_while_a_job_arrives(recording_path: anyio.Path) -> datetime | None:
        found = await real_estimate(recording_path)
        with tracker.claim_rendering(recording_path):
            pass
        return found

    mocker.patch(
        "ise_record.core.recordings._estimate_render_time_from_disk",
        side_effect=estimate_while_a_job_arrives,
    )

    assert not is_streaming(tracker, recording_dir(home, "GVS_2025"))
    assert not is_streaming(tracker, recording_dir(home, "GVS_2025"))


# A purge forgets what the tracker knew about the recording, so that a new recording of the
# same name starts from nothing rather than inheriting the old one's timestamps.


def test_a_purge_forgets_the_recording(home: Path):
    abandon_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass
    with tracker.claim_purging(recording(home, "GVS_2025")):
        shutil.rmtree(recording_dir(home, "GVS_2025"))

    # the same name, recorded again without its chunks reaching the server yet: if the old
    # upload were still on record, it would count as live
    recording_dir(home, "GVS_2025").mkdir()

    assert not is_streaming(tracker, recording_dir(home, "GVS_2025"))


def test_a_purge_that_is_refused_forgets_nothing(home: Path):
    # the recording is still there, and so is everything known about it
    abandon_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass
    with pytest.raises(RuntimeError), tracker.claim_purging(recording(home, "GVS_2025")):
        raise RuntimeError("refused")

    assert is_streaming(tracker, recording_dir(home, "GVS_2025"))


@pytest.mark.parametrize("history", ["nothing", "uploaded", "rendered"])
def test_a_purge_succeeds_whatever_the_tracker_knew_beforehand(home: Path, history: str):
    # a recording that was never rendered, or never touched since the server started, has
    # nothing on record to forget -- which must not turn a purge that worked into an error
    finish_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    if history == "uploaded":
        with tracker.claim_uploading(recording(home, "GVS_2025")):
            pass
    if history == "rendered":
        with tracker.claim_rendering(recording(home, "GVS_2025")):
            pass

    with tracker.claim_purging(recording(home, "GVS_2025")):
        shutil.rmtree(recording_dir(home, "GVS_2025"))

    assert tracker.activity(recording(home, "GVS_2025")) == RecordingActivity.NONE


# --- one recording, all three lines ------------------------------------------


def test_classify_reports_all_three_lines(home: Path):
    finish_recording(home, "GVS_2025", b"x" * 12345)
    write_chunks(recording_dir(home, "GVS_2025"), [5])
    tracker = RecordingTracker()

    with tracker.claim_rendering(recording(home, "GVS_2025")):
        info = anyio.run(tracker.classify, recording(home, "GVS_2025"))

    assert info == RecordingInfo(
        path=recording(home, "GVS_2025"),
        activity=RecordingActivity.RENDERING,
        disk_state=RecordingDiskState.FINISHED,
        streaming=False,
        size=12345,
    )


# --- the raw-data download -----------------------------------------------------
#
# The chunks of a recording as they were uploaded, for a lecture the render could not make
# anything of, or one the lecturer wants to cut differently. Streamed as the archive is
# written, so that a lecture of several gigabytes never has to fit in memory or in a
# temporary file.


def raw_download(path: Path, **kwargs: int) -> list[bytes]:
    """The pieces raw_download_zipstream hands to the response, in order."""

    async def collect() -> list[bytes]:
        return [piece async for piece in raw_download_zipstream(anyio.Path(path), **kwargs)]

    return anyio.run(collect)


def archive(pieces: list[bytes]) -> ZipFile:
    return ZipFile(BytesIO(b"".join(pieces)))


def write_file(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


@pytest.fixture
def leftovers_recording(home: Path) -> Path:
    """
    A recording with chunks in two tracks, written out of order, an empty third track, and
    everything else that ends up in a recording directory over its life.
    """
    path = recording_dir(home, "GVS_2025")
    for index in [10, 0, 2]:
        write_file(path / "stream" / f"chunk.{index:04d}", f"stream {index}".encode())
    for index in [1, 0]:
        write_file(path / "overlay" / f"chunk.{index:04d}", f"overlay {index}".encode())
    (path / "audio-0").mkdir()

    # an upload in progress, or one that broke off
    write_file(path / "stream" / "part.chunk.0011.k2x9q1zb", b"half a chunk")
    # what the render makes of the chunks, finished or not
    write_file(path / "stream" / "full.webm", b"concatenated")
    write_file(path / "presentation.webm", b"the rendered lecture")
    write_file(path / "presentation.part.webm", b"half a video")
    return path


CHUNKS_IN_ARCHIVE = {
    "GVS_2025/stream/chunk.0000",
    "GVS_2025/stream/chunk.0002",
    "GVS_2025/stream/chunk.0010",
    "GVS_2025/overlay/chunk.0000",
    "GVS_2025/overlay/chunk.0001",
}


def test_the_raw_download_is_a_zip_archive_of_the_chunks(leftovers_recording: Path):
    zipped = archive(raw_download(leftovers_recording))

    assert zipped.testzip() is None
    # under the recording's name, track by track, so that it unpacks into one directory laid
    # out like the one on the server -- rather than strewing chunk.0000s over the downloads
    assert set(zipped.namelist()) == CHUNKS_IN_ARCHIVE
    assert len(zipped.namelist()) == len(CHUNKS_IN_ARCHIVE)


def test_the_raw_download_holds_nothing_but_complete_chunks(leftovers_recording: Path):
    # a part file is a chunk still being uploaded, which the download may well run alongside;
    # full.webm and the presentation are made from the chunks, and as large as all of them
    # together, so they would double the download for nothing anybody asked for
    names = archive(raw_download(leftovers_recording)).namelist()

    assert not [name for name in names if "part" in name or name.endswith(".webm")]


def test_each_tracks_chunks_are_in_the_order_they_were_recorded(leftovers_recording: Path):
    # by name, which the zero padding makes the arrival order -- not the order the filesystem
    # happens to list them in
    names = archive(raw_download(leftovers_recording)).namelist()

    assert [name for name in names if "/stream/" in name] == [
        "GVS_2025/stream/chunk.0000",
        "GVS_2025/stream/chunk.0002",
        "GVS_2025/stream/chunk.0010",
    ]
    assert [name for name in names if "/overlay/" in name] == [
        "GVS_2025/overlay/chunk.0000",
        "GVS_2025/overlay/chunk.0001",
    ]


def test_every_chunk_arrives_byte_for_byte(leftovers_recording: Path):
    zipped = archive(raw_download(leftovers_recording))

    for name in CHUNKS_IN_ARCHIVE:
        assert zipped.read(name) == (leftovers_recording.parent / name).read_bytes()
    # stored rather than compressed: webm is compressed already, and deflating gigabytes of it
    # would only cost the server time
    assert {info.compress_type for info in zipped.infolist()} == {ZIP_STORED}


READ_SIZE = 64 * 1024
# a local file header with its zip64 extra field, the data descriptor of the entry before, and
# a recording name of a few dozen bytes; the end of the archive, with the central directory of
# the few entries here, is no larger
HEADER_ALLOWANCE = 1024


def test_a_chunk_larger_than_one_read_arrives_whole_without_being_held_in_memory(home: Path):
    # Each piece is handed on as soon as it is read, so memory per download stays at about
    # one read whatever the size of the chunks -- and of the lecture.
    content = os.urandom(16 * READ_SIZE + 123)
    write_file(recording_dir(home, "GVS_2025") / "stream" / "chunk.0000", content)

    pieces = raw_download(recording_dir(home, "GVS_2025"), chunk=READ_SIZE)

    assert archive(pieces).read("GVS_2025/stream/chunk.0000") == content
    assert len(pieces) > len(content) // READ_SIZE
    assert max(len(piece) for piece in pieces) <= READ_SIZE + HEADER_ALLOWANCE


def test_a_recording_without_chunks_is_an_empty_archive(home: Path):
    # the browser still gets a valid file to open, rather than one it cannot make sense of
    recording_dir(home, "GVS_2025").mkdir(parents=True)
    write_file(recording_dir(home, "GVS_2025") / "presentation.webm", b"the rendered lecture")

    zipped = archive(raw_download(recording_dir(home, "GVS_2025")))

    assert zipped.testzip() is None
    assert zipped.namelist() == []


def test_a_symlink_in_the_recording_is_not_followed_out_of_it(home: Path, tmp_path: Path):
    # nothing in the app creates one, but if one turns up, the download must not become a way
    # to read whatever it points at
    path = recording_dir(home, "GVS_2025")
    write_file(path / "stream" / "chunk.0000", b"stream 0")
    write_file(tmp_path / "secret" / "chunk.0000", b"secret")
    (path / "stream" / "chunk.0001").symlink_to(tmp_path / "secret" / "chunk.0000")
    (path / "overlay").symlink_to(tmp_path / "secret", target_is_directory=True)

    zipped = archive(raw_download(path))

    assert zipped.namelist() == ["GVS_2025/stream/chunk.0000"]
