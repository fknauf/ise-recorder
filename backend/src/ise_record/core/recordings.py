"""
Lists of recordings for display in the UI as server-side recordings, binned into finished,
rendering, and unprocessed/failed-postprocessing recordings.
"""

from collections import defaultdict
from collections.abc import Generator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, UTC
from enum import auto, Enum
from typing import NamedTuple

from anyio import Path

from ise_record.core.postprocess import MAIN_TRACK_NAME, OUTPUT_FILENAME


class RecordingState(Enum):
    """Current state of a recording"""

    NONEXISTENT = auto()
    STREAMING = auto()
    RENDERING = auto()
    FINISHED = auto()
    UNPROCESSED = auto()
    NOT_RENDERABLE = auto()
    PURGING = auto()


class RecordingInfo(NamedTuple):
    """Information about a recording"""

    path: Path
    state: RecordingState
    size: int | None = None


@dataclass
class BusyRecordings:
    """Currently busy recordings"""

    rendering: set[Path] = field(default_factory=set[Path])
    purging: set[Path] = field(default_factory=set[Path])

    def snapshot(self) -> BusyRecordings:
        """Copy of self, stable across awaits"""
        return BusyRecordings(rendering=self.rendering.copy(), purging=self.purging.copy())

    @contextmanager
    def _mark(self, busy_set: set[Path], recording_path: Path) -> Generator[None]:
        busy_set.add(recording_path)
        try:
            yield
        finally:
            busy_set.discard(recording_path)

    def mark_rendering(self, recording_path: Path) -> AbstractContextManager[None]:
        """
        Context manager that marks a recording as rendering while it's rendering so other requests
        will see it's rendering and not start rendering again or purging it.
        """
        return self._mark(self.rendering, recording_path)

    def mark_purging(self, recording_path: Path) -> AbstractContextManager[None]:
        """
        Context manager that marks a recording as being purged while it's being purged so other
        requests will see it's being purged and not start purging it again or rendering it.
        """
        return self._mark(self.purging, recording_path)

    def classify(self, recording_path: Path) -> RecordingState | None:
        """Classify the way a recording path is busy: rendering, purging, or None"""
        if recording_path in self.rendering:
            return RecordingState.RENDERING
        if recording_path in self.purging:
            return RecordingState.PURGING
        return None


class RecordingClasses(NamedTuple):
    """Recordings sorted into classes depending on their current state of processing"""

    finished: list[RecordingInfo]
    rendering: list[RecordingInfo]
    unprocessed: list[RecordingInfo]


async def _unfinished_state(main_track_dir: Path) -> RecordingState:
    chunks = [p async for p in main_track_dir.glob("chunk.*")]

    # no chunks in main track -> not renderable
    #
    # This should not normally happen because the directory is mkdir-ed when the first chunk is
    # uploaded, so this is either because the server crashed at just the wrong moment or because
    # the admin meddled with the file system.
    if len(chunks) == 0:
        return RecordingState.NOT_RENDERABLE

    # if the newest chunk is older than 5 minutes, the recording isn't still being streamed.
    cutoff = datetime.now(UTC) - timedelta(minutes=5)
    latest = max(chunks)

    if (await latest.stat()).st_mtime < cutoff.timestamp():
        return RecordingState.UNPROCESSED

    return RecordingState.STREAMING


async def _recording_state(recording_dir: Path, busy_recordings: BusyRecordings) -> RecordingState:
    output_path = recording_dir / OUTPUT_FILENAME
    main_track_dir = recording_dir / MAIN_TRACK_NAME

    if (busy_state := busy_recordings.classify(recording_dir)) is not None:
        return busy_state
    if not await recording_dir.is_dir(follow_symlinks=False):
        return RecordingState.NONEXISTENT
    if await output_path.is_file():
        return RecordingState.FINISHED
    if not await main_track_dir.is_dir() or await output_path.exists():
        # TODO: this also captures non-renderable recordings that are still streaming. For now
        # those just don't show up in the UI, but at some point I'll have to decide on a better
        # way to handle them. Should be rare though, so it's not urgent.
        return RecordingState.NOT_RENDERABLE

    return await _unfinished_state(main_track_dir)


async def classify_recording(recording_dir: Path, busy_recordings: BusyRecordings) -> RecordingInfo:
    """
    Classifies a recording according to its state of processing, and attaches the size of the
    output for finished recordings.
    """
    state = await _recording_state(recording_dir, busy_recordings)

    if state == RecordingState.FINISHED:
        output_path = recording_dir / OUTPUT_FILENAME
        size = (await output_path.stat()).st_size
        return RecordingInfo(path=recording_dir, state=state, size=size)

    return RecordingInfo(path=recording_dir, state=state)


async def recording_classes(user_home: Path, busy_recordings: BusyRecordings) -> RecordingClasses:
    """Returns a user's recordings arranged in classes according to their state"""

    bins = defaultdict[RecordingState, list[RecordingInfo]](list[RecordingInfo])

    async for path in user_home.iterdir():
        r = await classify_recording(path, busy_recordings)
        bins[r.state].append(r)

    for b in bins.values():
        b.sort(key=lambda r: r.path)

    return RecordingClasses(
        finished=bins[RecordingState.FINISHED],
        rendering=bins[RecordingState.RENDERING],
        unprocessed=bins[RecordingState.UNPROCESSED],
    )
