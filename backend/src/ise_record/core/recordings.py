"""
Lists of recordings for display in the UI as server-side recordings, binned into finished,
rendering, and unprocessed/failed-postprocessing recordings.
"""

from datetime import datetime, timedelta, UTC
from enum import auto, Enum
from pathlib import Path
from typing import NamedTuple

from ise_record.core.postprocess import MAIN_TRACK_NAME, OUTPUT_FILENAME


class RecordingState(Enum):
    """Current state of a recording"""

    NONEXISTENT = auto()
    STREAMING = auto()
    RENDERING = auto()
    FINISHED = auto()
    UNPROCESSED = auto()
    NOT_RENDERABLE = auto()


class RecordingInfo(NamedTuple):
    """Information about a recording"""

    path: Path
    state: RecordingState
    size: int | None = None


def _unfinished_state(main_track_dir: Path) -> RecordingState:
    chunks = sorted(main_track_dir.glob("chunk.*"), reverse=True)

    # no chunks in main track -> not renderable
    #
    # This should not normally happen because the directory is mkdir-ed when the first chunk is
    # uploaded, so this is either because the server crashed at just the wrong moment or because
    # the admin meddled with the file system.
    if len(chunks) == 0:
        return RecordingState.NOT_RENDERABLE

    # if the newest chunk is older than 5 minutes, the recording isn't still being streamed.
    cutoff = datetime.now(UTC) - timedelta(minutes=5)
    latest = chunks[0]

    if latest.stat().st_mtime < cutoff.timestamp():
        return RecordingState.UNPROCESSED

    return RecordingState.STREAMING


def _recording_state(recording_dir: Path, running_jobs: frozenset[Path]) -> RecordingState:
    output_path = recording_dir / OUTPUT_FILENAME
    main_track_dir = recording_dir / MAIN_TRACK_NAME

    if recording_dir in running_jobs:
        return RecordingState.RENDERING
    if not recording_dir.is_dir(follow_symlinks=False):
        return RecordingState.NONEXISTENT
    if output_path.is_file():
        return RecordingState.FINISHED
    if not main_track_dir.is_dir() or output_path.exists():
        # TODO: this also captures non-renderable recordings that are still streaming. For now
        # those just don't show up in the UI, but at some point I'll have to decide on a better
        # way to handle them. Should be rare though, so it's not urgent.
        return RecordingState.NOT_RENDERABLE

    return _unfinished_state(main_track_dir)


def classify_recording(recording_dir: Path, running_jobs: frozenset[Path]) -> RecordingInfo:
    """
    Classifies a recording according to its state of processing, and attaches the size of the
    output for finished recordings.
    """
    state = _recording_state(recording_dir, running_jobs)

    if state == RecordingState.FINISHED:
        output_path = recording_dir / OUTPUT_FILENAME
        size = output_path.stat().st_size
        return RecordingInfo(path=recording_dir, state=state, size=size)

    return RecordingInfo(path=recording_dir, state=state)


def classify_all_recordings(user_home: Path, running_jobs: frozenset[Path]) -> list[RecordingInfo]:
    """Classifies all recordings a user has"""
    return [classify_recording(path, running_jobs) for path in sorted(user_home.iterdir())]
