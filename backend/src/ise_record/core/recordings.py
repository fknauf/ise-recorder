"""
Query information about recordings, such as their activity and disk state. Also provide context
managers to mark recordings as busy when a recording is being rendered, purged, or a chunk is being
added to it.
"""

import asyncio
from collections import Counter
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, UTC
from enum import auto, Enum
import os
from typing import NamedTuple

from anyio import Path

from ise_record.core.postprocess import MAIN_TRACK_NAME, OUTPUT_FILENAME

STREAMING_GRACE_PERIOD = timedelta(minutes=2)


class RecordingActivity(Enum):
    """Current activity state of a recording"""

    NONE = auto()
    RENDERING = auto()
    PURGING = auto()
    UPLOADING = auto()


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


async def classify_disk_state(recording_path: Path) -> tuple[RecordingDiskState, int | None]:
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
    with os.scandir(track_path) as entries:
        last_chunk = max(
            (e for e in entries if e.name.startswith("chunk.")), key=lambda e: e.name, default=None
        )

        if last_chunk is None:
            return None

        return last_chunk.stat().st_mtime


async def _last_chunk_time_in_recording(recording_path: Path) -> datetime | None:
    if await recording_path.is_dir(follow_symlinks=False):
        last_upload_mtime = max(
            [
                await asyncio.to_thread(_last_chunk_mtime_in_track, track_path)
                async for track_path in recording_path.iterdir()
                if await track_path.is_dir(follow_symlinks=False)
            ],
            default=None,
        )

        if last_upload_mtime is not None:
            return datetime.fromtimestamp(last_upload_mtime, UTC)

    return None


class RecordingBusy(Exception):
    def __init__(self, state: RecordingActivity):
        super().__init__(state)
        self.state = state


class RecordingClasses(NamedTuple):
    """Recordings sorted into classes depending on their current state of processing"""

    finished: list[RecordingInfo]
    rendering: list[RecordingInfo]
    unprocessed: list[RecordingInfo]


@dataclass
class RecordingTracker:
    """Tracks activity/disk state/liveness of recordings"""

    rendering: set[Path] = field(default_factory=set[Path])
    purging: set[Path] = field(default_factory=set[Path])
    uploaders: Counter[Path] = field(default_factory=Counter[Path])
    last_upload_time: dict[Path, datetime | None] = field(
        default_factory=dict[Path, datetime | None]
    )
    last_render_time: dict[Path, datetime] = field(default_factory=dict[Path, datetime])

    def activity(self, recording_path: Path) -> RecordingActivity:
        """Returns whether a recording is currently performing an activity"""
        if recording_path in self.rendering:
            return RecordingActivity.RENDERING
        if recording_path in self.purging:
            return RecordingActivity.PURGING
        if self.uploaders[recording_path] > 0:
            return RecordingActivity.UPLOADING

        return RecordingActivity.NONE

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

        last_render = self.last_render_time.get(recording_path)
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

    async def recording_classes(self, user_home: Path) -> RecordingClasses:
        """Returns a user's recordings arranged in classes according to their state"""

        finished: list[RecordingInfo] = []
        rendering: list[RecordingInfo] = []
        unprocessed: list[RecordingInfo] = []

        async for path in user_home.iterdir():
            r = await self.classify(path)

            if r.activity == RecordingActivity.RENDERING:
                rendering.append(r)
            elif (
                r.disk_state == RecordingDiskState.FINISHED
                and r.activity != RecordingActivity.PURGING
            ):
                finished.append(r)
            elif (
                r.disk_state == RecordingDiskState.UNPROCESSED
                and r.activity == RecordingActivity.NONE
                and not r.streaming
            ):
                unprocessed.append(r)

        return RecordingClasses(
            finished=sorted(finished, key=lambda info: info.path.name),
            rendering=sorted(rendering, key=lambda info: info.path.name),
            unprocessed=sorted(unprocessed, key=lambda info: info.path.name),
        )

    @contextmanager
    def _claim(self, busy_set: set[Path], recording_path: Path) -> Generator[None]:
        act = self.activity(recording_path)

        if act != RecordingActivity.NONE:
            raise RecordingBusy(act)

        busy_set.add(recording_path)

        try:
            yield
        finally:
            busy_set.discard(recording_path)

    @contextmanager
    def claim_rendering(self, recording_path: Path) -> Generator[None]:
        """Claim a recording for rendering, to prevent other concurrent activities"""
        with self._claim(self.rendering, recording_path):
            self.last_render_time[recording_path] = datetime.now(UTC)
            yield

    @contextmanager
    def claim_purging(self, recording_path: Path) -> Generator[None]:
        """Claim a recording for purging, to prevent other concurrent activities"""
        with self._claim(self.purging, recording_path):
            yield
            self.last_upload_time.pop(recording_path, None)
            self.last_render_time.pop(recording_path, None)
            self.uploaders.pop(recording_path, 0)

    @contextmanager
    def claim_uploading(self, recording_path: Path) -> Generator[RecordingActivity]:
        """Claim a recording for upload, to prevent other concurrent activities except uploads"""
        state = self.activity(recording_path)

        # Allow uploads in almost all cases to avoid data loss. A broken post-processing can be
        # re-rendered later, a missing chunk cannot be replaced. But when purging it really makes
        # no sense and would be quite difficult to handle.
        if state != RecordingActivity.PURGING:
            self.uploaders[recording_path] += 1
        else:
            raise RecordingBusy(state)

        try:
            yield state
            self.last_upload_time[recording_path] = datetime.now(UTC)
        finally:
            self.uploaders[recording_path] -= 1
            if self.uploaders[recording_path] == 0:
                self.uploaders.pop(recording_path, 0)
