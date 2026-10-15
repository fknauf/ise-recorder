"""
Query information about recordings, such as their activity and disk state. Also provide context
managers to mark recordings as busy when a recording is being rendered, purged, or a chunk is being
added to it.
"""

import asyncio
from collections.abc import AsyncIterator, Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, UTC
from enum import auto, Enum
import os
from typing import NamedTuple
from zipfile import ZIP_STORED, ZipFile

from anyio import Path

from ise_record.core.postprocess import INTERMEDIATE_FILENAME, MAIN_TRACK_NAME, OUTPUT_FILENAME

STREAMING_GRACE_PERIOD = timedelta(minutes=2)


class RecordingActivity(Enum):
    """Current activity state of a recording"""

    NONE = auto()
    RENDERING = auto()
    PURGING = auto()
    UPLOADING = auto()
    ZIPPING = auto()


class RecordingDiskState(Enum):
    """Current disk state of a recording"""

    NONEXISTENT = auto()
    FINISHED = auto()
    UNPROCESSED = auto()
    NOT_RENDERABLE = auto()


class RecordingInfo(NamedTuple):
    """Information about a recording"""

    path: Path
    activity: RecordingActivity
    disk_state: RecordingDiskState
    streaming: bool
    size: int | None = None

    @property
    def name(self) -> str:
        """Name of the recording as used in the API"""
        return self.path.name


async def classify_disk_state(recording_path: Path) -> tuple[RecordingDiskState, int | None]:
    """
    on-disk state of a recording: does it exist, has it or has it not been post-processed yet, and
    is it renderable at all?
    """

    if not await recording_path.is_dir(follow_symlinks=False):
        return RecordingDiskState.NONEXISTENT, None

    output_path = recording_path / OUTPUT_FILENAME
    if await output_path.is_file():
        output_info = await output_path.stat()
        return RecordingDiskState.FINISHED, output_info.st_size

    main_track_dir = recording_path / MAIN_TRACK_NAME
    if (
        not await main_track_dir.is_dir()
        or await output_path.exists()
        or await anext(main_track_dir.glob("chunk.*"), None) is None
    ):
        return RecordingDiskState.NOT_RENDERABLE, None

    return RecordingDiskState.UNPROCESSED, None


def _last_chunk_mtime_in_track(track_path: Path) -> float | None:
    try:
        with os.scandir(track_path) as entries:
            last_chunk = max(
                (e for e in entries if e.name.startswith("chunk.")),
                key=lambda e: e.name,
                default=None,
            )

            if last_chunk is None:
                return None

            return last_chunk.stat().st_mtime
    except FileNotFoundError:
        # purely defensive safety net. Caller checks that track_path is a directory, and concurrent
        # purging is excluded by the fs lock in Enclave, so this should never happen.
        return None


async def _last_chunk_time_in_recording(recording_path: Path) -> datetime | None:
    if await recording_path.is_dir(follow_symlinks=False):
        track_mtimes = [
            await asyncio.to_thread(_last_chunk_mtime_in_track, track_path)
            async for track_path in recording_path.iterdir()
            if await track_path.is_dir(follow_symlinks=False)
        ]

        last_upload_mtime = max(
            (mtime for mtime in track_mtimes if mtime is not None), default=None
        )

        if last_upload_mtime is not None:
            return datetime.fromtimestamp(last_upload_mtime, UTC)

    return None


async def _estimate_render_time_from_disk(recording_path: Path) -> datetime | None:
    for fname in [OUTPUT_FILENAME, INTERMEDIATE_FILENAME]:
        file_path = recording_path / fname
        if await file_path.is_file():
            file_stat = await file_path.stat()
            return datetime.fromtimestamp(file_stat.st_mtime, UTC)

    return None


class RecordingBusy(Exception):
    """
    Exception thrown when an action is attempted that the current activity state of a recording
    doesn't permit, e.g. purging it while it's rendering or accepting an upload
    """

    def __init__(self, state: RecordingActivity):
        super().__init__(state)
        self.state = state


@dataclass
class RecordingActivityState:
    """
    Activity state of a recording: is rendering, being purged, accepting an upload or being zipped?

    There are mildly complex exclusivity rules between those states, i.e.

    - a recording that's busy with anything can't be purged
    - a recording that's being purged can't do anything else
    - a recording that's accepting an upload can't be rendered yet
    """

    busy_with: RecordingActivity = RecordingActivity.NONE
    uploaders: int = 0
    zippers: int = 0

    def claim(self, activity: RecordingActivity) -> None:
        """
        Claim the recording for a particular activity. This will check whether the activity is
        currently possible (throw otherwise) and update the state to reflect the activity for
        which it was claimed.
        """

        assert activity != RecordingActivity.NONE

        match activity:
            # Purging conflicts with everything
            case RecordingActivity.PURGING:
                if self.busy_with != RecordingActivity.NONE:
                    raise RecordingBusy(self.busy_with)
                if self.uploaders > 0:
                    raise RecordingBusy(RecordingActivity.UPLOADING)
                if self.zippers > 0:
                    raise RecordingBusy(RecordingActivity.ZIPPING)
                self.busy_with = RecordingActivity.PURGING

            # Rendering conflicts with purging but allows uploads and raw-data downloads
            case RecordingActivity.RENDERING:
                if self.busy_with != RecordingActivity.NONE:
                    raise RecordingBusy(self.busy_with)
                if self.uploaders > 0:
                    raise RecordingBusy(RecordingActivity.UPLOADING)
                self.busy_with = RecordingActivity.RENDERING

            # Uploading conflicts with purging but not other uploads, raw-data downloads or
            # rendering. This works because the upload uses temporary files that the zipping logic
            # ignores.
            case RecordingActivity.UPLOADING:
                if self.busy_with == RecordingActivity.PURGING:
                    raise RecordingBusy(RecordingActivity.PURGING)
                self.uploaders += 1

            # Zipping conflicts with purging but not other raw-data downloads, uploads or
            # rendering.
            case RecordingActivity.ZIPPING:
                if self.busy_with == RecordingActivity.PURGING:
                    raise RecordingBusy(RecordingActivity.PURGING)
                self.zippers += 1

    def release(self, activity: RecordingActivity) -> None:
        """Signal that an activity has ended and update the state accordingly."""

        match activity:
            case RecordingActivity.ZIPPING:
                assert self.zippers > 0
                self.zippers -= 1

            case RecordingActivity.UPLOADING:
                assert self.uploaders > 0
                self.uploaders -= 1

            case _:
                assert self.busy_with == activity
                self.busy_with = RecordingActivity.NONE

    def summary(self) -> RecordingActivity:
        """
        Summarize the activity state into one dominant activity.
        
        Used in the decision how to display the recording in the UI. For the purpose of this,
        uploading and zipping are considered background activities, so everything else takes
        precedence.
        """
        if self.busy_with != RecordingActivity.NONE:
            return self.busy_with
        if self.uploaders > 0:
            return RecordingActivity.UPLOADING
        if self.zippers > 0:
            return RecordingActivity.ZIPPING

        return RecordingActivity.NONE


@dataclass
class RecordingTracker:
    """Tracks activity/disk state/liveness of recordings"""

    activities: dict[Path, RecordingActivityState] = field(
        default_factory=dict[Path, RecordingActivityState]
    )

    last_upload_time: dict[Path, datetime | None] = field(
        default_factory=dict[Path, datetime | None]
    )
    last_render_time: dict[Path, datetime | None] = field(
        default_factory=dict[Path, datetime | None]
    )

    def activity(self, recording_path: Path) -> RecordingActivity:
        """Returns whether a recording is currently performing an activity"""
        activity = self.activities.get(recording_path)

        if activity is None:
            return RecordingActivity.NONE
        return activity.summary()

    async def streaming(self, recording_path: Path) -> bool:
        """
        Returns whether a recording is currently being streamed, i.e. has received a chunk upload
        recently and not received a post-processing job afterwards. Heuristic.
        """
        if recording_path in self.last_upload_time:
            last_upload = self.last_upload_time[recording_path]
        else:
            # Fill cache from disk state. This happens the first time after the server restarts.
            # setdefault to avoid overwriting what another request might have written while we wait
            last_upload = await _last_chunk_time_in_recording(recording_path)
            last_upload = self.last_upload_time.setdefault(recording_path, last_upload)

        if recording_path in self.last_render_time:
            last_render = self.last_render_time[recording_path]
        else:
            # If the backend is restarted shortly after a job has been scheduled for a recording,
            # we don't have the render time in the cache, so estimate from disk. This covers a few
            # edge cases where otherwise a just-finished recording would be classified as streaming
            # until the end of the grace period. Doesn't cover cases where the rendering job got
            # interrupted before the main ffmpeg call that writes the intermediate file, that's an
            # accepted limitation.
            last_render = await _estimate_render_time_from_disk(recording_path)
            last_render = self.last_render_time.setdefault(recording_path, last_render)

        cutoff = datetime.now(UTC) - STREAMING_GRACE_PERIOD

        return (
            last_upload is not None
            and (last_render is None or last_upload > last_render)
            and last_upload > cutoff
        )

    async def classify(self, recording_path: Path) -> RecordingInfo:
        """Gather information about a recording's activity, liveness and disk state"""

        activity = self.activity(recording_path)
        disk_state, size = await classify_disk_state(recording_path)
        streaming = await self.streaming(recording_path)

        return RecordingInfo(
            path=recording_path,
            activity=activity,
            disk_state=disk_state,
            streaming=streaming,
            size=size,
        )

    @contextmanager
    def _claim(self, recording_path: Path, activity: RecordingActivity) -> Generator[None]:
        state = self.activities.get(recording_path)

        if state is None:
            state = RecordingActivityState()
            self.activities[recording_path] = state

        state.claim(activity)

        try:
            yield
        finally:
            state.release(activity)
            if state.summary() == RecordingActivity.NONE:
                self.activities.pop(recording_path, None)

    @contextmanager
    def claim_rendering(self, recording_path: Path) -> Generator[None]:
        """Claim a recording for rendering, to prevent other concurrent activities"""
        with self._claim(recording_path, RecordingActivity.RENDERING):
            self.last_render_time[recording_path] = datetime.now(UTC)
            yield

    @contextmanager
    def claim_purging(self, recording_path: Path) -> Generator[None]:
        """Claim a recording for purging, to prevent other concurrent activities"""
        with self._claim(recording_path, RecordingActivity.PURGING):
            yield
            self.last_upload_time.pop(recording_path, None)
            self.last_render_time.pop(recording_path, None)

    @contextmanager
    def claim_uploading(self, recording_path: Path) -> Generator[None]:
        """Claim a recording for upload, to prevent other concurrent activities except uploads"""
        with self._claim(recording_path, RecordingActivity.UPLOADING):
            yield
            self.last_upload_time[recording_path] = datetime.now(UTC)

    @contextmanager
    def claim_zipping(self, recording_path: Path) -> Generator[None]:
        """Claim a recording for zipping / raw data download"""
        with self._claim(recording_path, RecordingActivity.ZIPPING):
            yield


class _MemorySink:
    def __init__(self):
        self.buf = bytearray()
        self.offset = 0

    def write(self, b: bytes) -> int:
        """write a chunk of data to the sink"""
        self.buf += b
        self.offset += len(b)
        return len(b)

    def flush(self) -> None:
        """dummy function to fulfill the IO contract"""

    def close(self) -> None:
        """dummy function to fulfill the IO contract"""

    def tell(self) -> int:
        """Tells how many bytes have been written so far"""
        return self.offset

    def drain(self) -> bytes:
        """Take the current data buffer out of the sink and reset the buffer"""
        out = bytes(self.buf)
        self.buf.clear()
        return out


async def raw_download_zipstream(recording_dir: Path, chunk: int = 2 << 20) -> AsyncIterator[bytes]:
    """
    Create an iterator into which the raw chunks in the specified recording directory is streamed
    """
    sink = _MemorySink()

    with ZipFile(sink, "w", compression=ZIP_STORED) as zf:
        track_dirs = sorted([p async for p in recording_dir.iterdir()], key=lambda p: p.name)

        for track_dir in track_dirs:
            if not await track_dir.is_dir(follow_symlinks=False):
                continue

            chunk_files = sorted([p async for p in track_dir.glob("chunk.*")], key=lambda p: p.name)

            for chunk_file in chunk_files:
                if not await chunk_file.is_file(follow_symlinks=False):
                    continue

                name_in_archive = chunk_file.relative_to(recording_dir.parent).as_posix()

                async with await chunk_file.open("rb") as src:
                    with zf.open(name_in_archive, "w", force_zip64=True) as dst:
                        while data := await src.read(chunk):
                            dst.write(data)
                            yield sink.drain()

    yield sink.drain()
