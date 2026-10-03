"""
What the server knows about a recording, along three separate lines:

- its disk state: finished, renderable but unprocessed, not renderable, or not there at all --
  read off the filesystem;
- its activity: whether a render, a purge or chunk uploads have claimed it -- kept in memory,
  and taken and released through the claims, which are what keep two of those from running
  over each other;
- its liveness: whether it still looks like it is being streamed -- a guess from when its last
  chunk arrived, since nothing tells the server that a lecture has ended.

The listing projects the three onto the lists the frontend shows; the endpoints ask the line
they care about directly. The endpoints' side of it is in glue/test_recordings.py and
test_server.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from collections.abc import Callable
from contextlib import AbstractContextManager, ExitStack
from datetime import datetime, timedelta
from pathlib import Path
import shutil

import anyio
import pytest
from pytest_mock import MockerFixture

from ise_record.core import recordings
from ise_record.core.recordings import (
    classify_disk_state,
    RecordingActivity,
    RecordingBusy,
    RecordingClasses,
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
    write_chunks,
)


@pytest.fixture
def home(tmp_path: Path) -> Path:
    user_home = tmp_path / "home"
    user_home.mkdir()
    return user_home


def recording(home: Path, name: str) -> anyio.Path:
    """The path the tracker is handed for a recording: an anyio one, as the enclave builds it."""
    return anyio.Path(home / name)


def disk_state_of(recording_dir: Path) -> RecordingDiskState:
    state, _ = anyio.run(classify_disk_state, anyio.Path(recording_dir))
    return state


def is_streaming(tracker: RecordingTracker, recording_dir: Path) -> bool:
    return anyio.run(tracker.streaming, anyio.Path(recording_dir))


def classes_of(tracker: RecordingTracker, user_home: Path) -> RecordingClasses:
    return anyio.run(tracker.recording_classes, anyio.Path(user_home))


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
    write_chunks(home / "LIVE_2026", [5])

    assert disk_state_of(home / "LIVE_2026") == RecordingDiskState.UNPROCESSED


def test_a_failed_render_left_behind_is_unprocessed(home: Path):
    # the case the Rerender button is mostly for: ffmpeg ran and failed, and its partial
    # output is kept for inspection -- which must not be mistaken for the finished file
    recording_dir = abandon_recording(home, "GVS_2025")
    (recording_dir / "presentation.part.webm").write_bytes(b"half")

    assert disk_state_of(recording_dir) == RecordingDiskState.UNPROCESSED


def test_a_concatenation_left_behind_is_still_unprocessed(home: Path):
    # concat_chunks writes full.webm into the stream directory itself, and a crash in the
    # middle of it leaves the file there next to the chunks it was made from
    recording_dir = abandon_recording(home, "GVS_2025")
    (recording_dir / "stream" / "full.webm").write_bytes(b"concatenated")

    assert disk_state_of(recording_dir) == RecordingDiskState.UNPROCESSED


# --- disk state: not renderable --------------------------------------------


def test_a_recording_without_a_main_stream_is_not_renderable(home: Path):
    # postprocessing gives up on these with MAIN_STREAM_MISSING, so a Rerender button would
    # only ever fail again
    write_chunks(home / "GVS_2025", [30 * MINUTE], track="overlay")

    assert disk_state_of(home / "GVS_2025") == RecordingDiskState.NOT_RENDERABLE


def test_chunks_in_another_track_do_not_make_up_for_an_empty_main_stream(home: Path):
    # the overlay and audio tracks are layered onto the main stream; without it there is
    # nothing to render, however many chunks the other tracks hold
    (home / "GVS_2025" / "stream").mkdir(parents=True)
    write_chunks(home / "GVS_2025", [30 * MINUTE], track="overlay")
    write_chunks(home / "GVS_2025", [30 * MINUTE], track="audio-0")

    assert disk_state_of(home / "GVS_2025") == RecordingDiskState.NOT_RENDERABLE


def test_a_recording_with_an_empty_main_stream_is_not_renderable(home: Path):
    # the directory is created just before the first chunk is written into it
    (home / "GVS_2025" / "stream").mkdir(parents=True)

    assert disk_state_of(home / "GVS_2025") == RecordingDiskState.NOT_RENDERABLE


def test_a_main_stream_with_only_a_leftover_concatenation_is_not_renderable(home: Path):
    stream_dir = home / "GVS_2025" / "stream"
    stream_dir.mkdir(parents=True)
    (stream_dir / "full.webm").write_bytes(b"concatenated")

    assert disk_state_of(home / "GVS_2025") == RecordingDiskState.NOT_RENDERABLE


def test_a_main_stream_with_only_a_partial_chunk_is_not_renderable(home: Path):
    # an upload writes to part.chunk.* and renames it once it is complete; a part file left
    # by an upload that broke off is not a chunk
    stream_dir = home / "GVS_2025" / "stream"
    stream_dir.mkdir(parents=True)
    (stream_dir / "part.chunk.0000").write_bytes(b"half a chunk")

    assert disk_state_of(home / "GVS_2025") == RecordingDiskState.NOT_RENDERABLE


def test_an_output_that_is_not_a_file_is_not_renderable(home: Path):
    # rendering would have to write presentation.webm where something else already is
    recording_dir = abandon_recording(home, "GVS_2025")
    (recording_dir / "presentation.webm").mkdir()

    assert disk_state_of(recording_dir) == RecordingDiskState.NOT_RENDERABLE


# --- disk state: not a recording -------------------------------------------


def test_a_missing_directory_is_nonexistent(home: Path):
    assert disk_state_of(home / "never_recorded") == RecordingDiskState.NONEXISTENT


def test_a_stray_file_is_nonexistent(home: Path):
    (home / "notes.txt").write_text("not a recording")

    assert disk_state_of(home / "notes.txt") == RecordingDiskState.NONEXISTENT


def test_a_symlink_is_not_followed(home: Path, tmp_path: Path):
    # nothing in the app creates one, but if one turns up in a home directory it must not
    # be classified by what it points at: as finished it would be listed for download and
    # offered for purging, with the listing and the purge acting on its target
    finish_recording(tmp_path, "victim")
    (home / "link").symlink_to(tmp_path / "victim", target_is_directory=True)

    assert disk_state_of(home / "link") == RecordingDiskState.NONEXISTENT


# --- activity: the claims ---------------------------------------------------

Claim = Callable[[RecordingTracker, anyio.Path], AbstractContextManager[object]]

CLAIMS = [
    pytest.param(RecordingTracker.claim_rendering, RecordingActivity.RENDERING, id="rendering"),
    pytest.param(RecordingTracker.claim_purging, RecordingActivity.PURGING, id="purging"),
    pytest.param(RecordingTracker.claim_uploading, RecordingActivity.UPLOADING, id="uploading"),
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


# What may run alongside what. Rendering and purging need the recording to themselves: a
# purge would take the chunks away from under ffmpeg, a second render would write over the
# first one's files. Uploads may run alongside anything but a purge, because a chunk that is
# refused may be gone for good, while a render that missed it can be repeated.

EXCLUSIVE_CLAIMS = [
    pytest.param(RecordingTracker.claim_rendering, id="rendering"),
    pytest.param(RecordingTracker.claim_purging, id="purging"),
]


@pytest.mark.parametrize("blocked", EXCLUSIVE_CLAIMS)
@pytest.mark.parametrize("holding, activity", CLAIMS)
def test_rendering_and_purging_need_the_recording_to_themselves(
    home: Path, holding: Claim, activity: RecordingActivity, blocked: Claim
):
    tracker = RecordingTracker()

    with holding(tracker, recording(home, "foo")):
        with pytest.raises(RecordingBusy) as excinfo, blocked(tracker, recording(home, "foo")):
            pytest.fail("claimed a recording that was already claimed")

        # the refusal says what is in the way
        assert excinfo.value.state == activity
        # and the claim that was there first keeps the recording
        assert tracker.activity(recording(home, "foo")) == activity

    assert tracker.activity(recording(home, "foo")) == RecordingActivity.NONE


def test_an_upload_is_refused_while_the_recording_is_purged(home: Path):
    # the chunk would land in a directory that rmtree is taking apart, or bring it back
    tracker = RecordingTracker()

    with tracker.claim_purging(recording(home, "foo")):
        with (
            pytest.raises(RecordingBusy) as excinfo,
            tracker.claim_uploading(recording(home, "foo")),
        ):
            pytest.fail("uploaded into a recording being purged")

        assert excinfo.value.state == RecordingActivity.PURGING


def test_an_upload_is_accepted_while_the_recording_renders(home: Path):
    # a late chunk is kept for a rerender rather than lost; the upload writes it under a
    # name the render does not read until it is complete
    tracker = RecordingTracker()

    with tracker.claim_rendering(recording(home, "foo")):
        with tracker.claim_uploading(recording(home, "foo")):
            # the render in flight is what the listing and the other claims have to know about
            assert tracker.activity(recording(home, "foo")) == RecordingActivity.RENDERING

        assert tracker.activity(recording(home, "foo")) == RecordingActivity.RENDERING


def test_uploads_run_alongside_each_other(home: Path):
    # the frontend uploads its tracks' chunks in parallel, and retries overlap with new ones
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "foo")):
        with tracker.claim_uploading(recording(home, "foo")):
            assert tracker.activity(recording(home, "foo")) == RecordingActivity.UPLOADING

        # one of them done is not all of them done: a purge must still wait
        assert tracker.activity(recording(home, "foo")) == RecordingActivity.UPLOADING

    assert tracker.activity(recording(home, "foo")) == RecordingActivity.NONE


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

    assert is_streaming(tracker, home / "GVS_2025")


def test_a_recording_stops_being_live_once_the_grace_period_has_passed(home: Path, clock: Clock):
    write_chunks(home / "GVS_2025", [5])
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass
    clock.advance(STREAMING_GRACE_PERIOD - timedelta(seconds=10))

    assert is_streaming(tracker, home / "GVS_2025")

    clock.advance(timedelta(seconds=20))

    assert not is_streaming(tracker, home / "GVS_2025")


def test_a_failed_upload_is_not_a_sign_of_life(home: Path):
    abandon_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    with pytest.raises(OSError), tracker.claim_uploading(recording(home, "GVS_2025")):
        raise OSError("disk full")

    assert not is_streaming(tracker, home / "GVS_2025")


def test_a_job_request_ends_the_stream(home: Path):
    # the frontend asks for the render once the lecture is over, so that is the end of it,
    # with no need to wait out the grace period
    write_chunks(home / "GVS_2025", [5])
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass
    with tracker.claim_rendering(recording(home, "GVS_2025")):
        pass

    assert not is_streaming(tracker, home / "GVS_2025")


def test_a_chunk_after_the_job_makes_the_recording_live_again(home: Path):
    write_chunks(home / "GVS_2025", [5])
    tracker = RecordingTracker()

    with tracker.claim_rendering(recording(home, "GVS_2025")):
        pass
    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass

    assert is_streaming(tracker, home / "GVS_2025")


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

    assert is_streaming(tracker, home / "GVS_2025")


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
    write_chunks(home / "GVS_2025", [fraction * GRACE_SECONDS])

    assert is_streaming(RecordingTracker(), home / "GVS_2025") == streaming


def test_after_a_restart_a_lecture_in_progress_is_judged_by_its_newest_chunk(home: Path):
    # an hour-long lecture in progress: its first chunks are long past the cutoff, but the
    # newest one was written seconds ago
    write_chunks(home / "LIVE_2026", [60 * MINUTE, 30 * MINUTE, 10 * MINUTE, 5])

    assert is_streaming(RecordingTracker(), home / "LIVE_2026")


def test_the_newest_chunk_is_picked_by_name_not_by_listing_order(home: Path):
    # chunk names are zero-padded to a fixed width, which is what makes the name order the
    # arrival order
    track_dir = home / "LONG_2026" / "stream"
    track_dir.mkdir(parents=True)

    for index, seconds in [(0, 60 * MINUTE), (9998, 20 * MINUTE), (9999, 5)]:
        chunk = track_dir / f"chunk.{index:04d}"
        chunk.write_bytes(b"chunk")
        age(chunk, seconds)

    assert is_streaming(RecordingTracker(), home / "LONG_2026")


def test_after_a_restart_a_fresh_chunk_in_any_track_counts(home: Path):
    # the first seconds of a lecture, if its overlay chunks arrive before the main track's:
    # not renderable yet, but certainly live, and not to be purged from under the streamer
    write_chunks(home / "LIVE_2026", [5], track="overlay")

    assert is_streaming(RecordingTracker(), home / "LIVE_2026")


def test_a_concatenation_left_behind_is_not_a_fresh_chunk(home: Path):
    # concat_chunks writes full.webm into the stream directory, after every chunk
    recording_dir = abandon_recording(home, "GVS_2025")
    (recording_dir / "stream" / "full.webm").write_bytes(b"concatenated")

    assert not is_streaming(RecordingTracker(), recording_dir)


@pytest.mark.parametrize("name", ["never_recorded", "notes.txt", "link"])
def test_something_that_is_not_a_recording_is_not_live(home: Path, tmp_path: Path, name: str):
    # and asking does not fail: the listing asks about everything in the home directory
    (home / "notes.txt").write_text("not a recording")
    write_chunks(tmp_path / "victim", [5])
    (home / "link").symlink_to(tmp_path / "victim", target_is_directory=True)

    assert not is_streaming(RecordingTracker(), home / name)


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

    assert is_streaming(tracker, home / "GVS_2025")
    # and the record keeps the upload, which a second look finds without scanning
    assert is_streaming(tracker, home / "GVS_2025")


# After a restart the render time is gone from memory as well. Without it, a recording whose
# job ran just before the restart would count as live for the rest of the grace period, since
# its chunks are as fresh as a lecture's in progress. What ffmpeg left on disk stands in for
# it: the output, or the intermediate file a render that broke off had started writing.


def test_after_a_restart_a_recording_rendered_since_its_last_chunk_is_not_live(home: Path):
    write_chunks(home / "GVS_2025", [30, 20])
    finish_recording(home, "GVS_2025")

    assert not is_streaming(RecordingTracker(), home / "GVS_2025")


def test_after_a_restart_a_render_that_broke_off_counts_as_the_end_of_the_stream(home: Path):
    # the job was requested, so the lecture was over; ffmpeg had got as far as writing
    write_chunks(home / "GVS_2025", [30, 20])
    (home / "GVS_2025" / "presentation.part.webm").write_bytes(b"half a video")

    assert not is_streaming(RecordingTracker(), home / "GVS_2025")


def test_after_a_restart_a_render_that_left_nothing_on_disk_does_not_end_the_stream(home: Path):
    # the accepted gap: a job that broke off before ffmpeg wrote anything leaves no trace, so
    # the recording counts as live until the grace period is over
    write_chunks(home / "GVS_2025", [30, 20])

    assert is_streaming(RecordingTracker(), home / "GVS_2025")


def test_after_a_restart_chunks_newer_than_the_last_render_are_live(home: Path):
    # a lecture streamed again under the name of an old one, whose output is still there
    finish_recording(home, "GVS_2025")
    age(home / "GVS_2025" / "presentation.webm", 60 * MINUTE)
    write_chunks(home / "GVS_2025", [5])

    assert is_streaming(RecordingTracker(), home / "GVS_2025")


def test_a_look_at_the_disk_does_not_overwrite_a_job_requested_meanwhile(
    mocker: MockerFixture, home: Path
):
    # the same race as for the upload: the estimate awaits the disk, and a job requested in
    # the middle of it is newer than anything the estimate can find
    finish_recording(home, "GVS_2025")
    age(home / "GVS_2025" / "presentation.webm", 60 * MINUTE)
    write_chunks(home / "GVS_2025", [5])
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

    assert not is_streaming(tracker, home / "GVS_2025")
    assert not is_streaming(tracker, home / "GVS_2025")


# A purge forgets what the tracker knew about the recording, so that a new recording of the
# same name starts from nothing rather than inheriting the old one's timestamps.


def test_a_purge_forgets_the_recording(home: Path):
    abandon_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass
    with tracker.claim_purging(recording(home, "GVS_2025")):
        shutil.rmtree(home / "GVS_2025")

    # the same name, recorded again without its chunks reaching the server yet: if the old
    # upload were still on record, it would count as live
    (home / "GVS_2025").mkdir()

    assert not is_streaming(tracker, home / "GVS_2025")


def test_a_purge_that_is_refused_forgets_nothing(home: Path):
    # the recording is still there, and so is everything known about it
    abandon_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        pass
    with pytest.raises(RuntimeError), tracker.claim_purging(recording(home, "GVS_2025")):
        raise RuntimeError("refused")

    assert is_streaming(tracker, home / "GVS_2025")


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
        shutil.rmtree(home / "GVS_2025")

    assert tracker.activity(recording(home, "GVS_2025")) == RecordingActivity.NONE


# --- one recording, all three lines ------------------------------------------


def test_classify_reports_all_three_lines(home: Path):
    finish_recording(home, "GVS_2025", b"x" * 12345)
    write_chunks(home / "GVS_2025", [5])
    tracker = RecordingTracker()

    with tracker.claim_rendering(recording(home, "GVS_2025")):
        info = anyio.run(tracker.classify, recording(home, "GVS_2025"))

    assert info == RecordingInfo(
        path=home / "GVS_2025",
        activity=RecordingActivity.RENDERING,
        disk_state=RecordingDiskState.FINISHED,
        streaming=False,
        size=12345,
    )


# --- every recording at once, sorted into the lists the frontend shows -------


def names(infos: list[RecordingInfo]) -> list[str]:
    return [r.path.name for r in infos]


def test_each_recording_lands_in_the_list_for_its_state(home: Path):
    finish_recording(home, "DONE_2025")
    abandon_recording(home, "FAILED_2025")
    abandon_recording(home, "BUSY_2025")
    tracker = RecordingTracker()

    with tracker.claim_rendering(recording(home, "BUSY_2025")):
        classes = classes_of(tracker, home)

    assert names(classes.finished) == ["DONE_2025"]
    assert names(classes.rendering) == ["BUSY_2025"]
    assert names(classes.unprocessed) == ["FAILED_2025"]


def test_a_finished_recording_keeps_its_size_in_the_list(home: Path):
    finish_recording(home, "DONE_2025", b"twelve bytes")

    assert [r.size for r in classes_of(RecordingTracker(), home).finished] == [12]


def test_an_empty_home_directory_gives_three_empty_lists(home: Path):
    # every list is looked up whether or not anything landed in it
    assert classes_of(RecordingTracker(), home) == RecordingClasses([], [], [])


def test_a_rerender_is_listed_as_rendering_rather_than_finished(home: Path):
    # the previous output stays on disk until the new one replaces it. Listed as finished,
    # it would be offered for download and for purging while ffmpeg works on it.
    abandon_recording(home, "GVS_2025")
    finish_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    with tracker.claim_rendering(recording(home, "GVS_2025")):
        classes = classes_of(tracker, home)

    assert names(classes.rendering) == ["GVS_2025"]
    assert classes.finished == []


def test_a_recording_being_purged_is_left_out(home: Path):
    # the frontend removed its card the moment the purge was confirmed; listing it again,
    # under any heading, would bring the card back until the purge is done
    finish_recording(home, "DONE_2025")
    finish_recording(home, "KEPT_2025")
    abandon_recording(home, "FAILED_2025")
    tracker = RecordingTracker()

    with (
        tracker.claim_purging(recording(home, "DONE_2025")),
        tracker.claim_purging(recording(home, "FAILED_2025")),
    ):
        classes = classes_of(tracker, home)

    assert names(classes.finished) == ["KEPT_2025"]
    assert classes.rendering == classes.unprocessed == []


def test_a_recording_that_is_still_streamed_is_not_offered_for_rerendering(home: Path):
    # Rerender and Purge on a lecture that is still going would be the wrong buttons
    write_chunks(home / "LIVE_2026", [5])

    assert classes_of(RecordingTracker(), home) == RecordingClasses([], [], [])


def test_a_recording_receiving_a_chunk_right_now_is_not_offered_for_rerendering(home: Path):
    abandon_recording(home, "GVS_2025")
    tracker = RecordingTracker()

    with tracker.claim_uploading(recording(home, "GVS_2025")):
        classes = classes_of(tracker, home)

    assert classes.unprocessed == []


def test_recordings_the_frontend_has_no_card_for_are_left_out(home: Path, tmp_path: Path):
    write_chunks(home / "NO_MAIN_2025", [30 * MINUTE], track="overlay")
    (home / "notes.txt").write_text("not a recording")
    finish_recording(tmp_path, "victim")
    (home / "link").symlink_to(tmp_path / "victim", target_is_directory=True)

    assert classes_of(RecordingTracker(), home) == RecordingClasses([], [], [])


def test_each_list_keeps_the_name_order(home: Path):
    # the listing renders them as they come, so without the sort the cards would appear in
    # whatever order the filesystem hands them out
    unsorted = ["PSU_2026", "ABC_2026", "XYZ_2024", "GVS_2025", "MMM_2025"]
    in_order = ["ABC_2026", "GVS_2025", "MMM_2025", "PSU_2026", "XYZ_2024"]
    tracker = RecordingTracker()

    for name in unsorted:
        finish_recording(home, f"DONE_{name}")
        abandon_recording(home, f"FAILED_{name}")
        abandon_recording(home, f"BUSY_{name}")

    with ExitStack() as jobs:
        for name in unsorted:
            jobs.enter_context(tracker.claim_rendering(recording(home, f"BUSY_{name}")))

        classes = classes_of(tracker, home)

    assert names(classes.finished) == [f"DONE_{name}" for name in in_order]
    assert names(classes.rendering) == [f"BUSY_{name}" for name in in_order]
    assert names(classes.unprocessed) == [f"FAILED_{name}" for name in in_order]
