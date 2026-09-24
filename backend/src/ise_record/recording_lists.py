"""
Lists of recordings for display in the UI as server-side recordings, binned into finished,
rendering, and unprocessed/failed-postprocessing recordings.
"""

from datetime import datetime, timedelta
from pathlib import Path
from typing import Annotated, NamedTuple

from fastapi import Depends

from .download_totp import DownloadTotpAuthority, get_download_totp
from .jobs import get_running_jobs_snapshot
from .postprocess import MAIN_TRACK_NAME, OUTPUT_FILENAME
from .settings import Settings, get_settings
from .user_home import get_current_user_home

def get_unprocessed_recordings(
    settings: Annotated[Settings, Depends(get_settings)],
    user_home: Annotated[Path, Depends(get_current_user_home)],
    running_jobs: Annotated[frozenset[Path], Depends(get_running_jobs_snapshot)]
) -> list[Path]:
    """
    Identify recordings that haven't been processed, aren't being processed, aren't still being
    streamed and are processable (i.e., have a main stream).

    These will be shown in the UI as failed postprocessings with a button that allows rescheduling
    the post-processing job. They should only show up in the event that something went wrong, e.g.
    a streaming lecturer lost connectivity before the postprocessing could be scheduled.
    """
    if not settings.auth_required:
        return []

    running_job_names = { job.name for job in running_jobs }

    def is_unprocessed(recording_dir: Path) -> bool:
        output_path = recording_dir / OUTPUT_FILENAME
        main_track_dir = recording_dir / MAIN_TRACK_NAME

        # - name in running_job_names -> is currently rendering
        # - presentation.webm exists -> preprocessing finished
        # - main track doesn't exist -> not renderable.
        if (
            recording_dir.name in running_job_names
            or output_path.exists()
            or not main_track_dir.is_dir()
        ):
            return False

        chunks = sorted(main_track_dir.glob("chunk.*"), reverse=True)

        # no chunks in main track -> not renderable
        if len(chunks) == 0:
            return False

        # if the newest chunk is older than 5 minutes, the recording isn't still being streamed.
        cutoff = datetime.now() - timedelta(minutes=5)
        latest = chunks[0]

        return latest.stat().st_mtime < cutoff.timestamp()

    return sorted(dir for dir in user_home.iterdir() if is_unprocessed(dir))


class DownloadableRecording(NamedTuple):
    """ Per-downloadable-file information for the frontend """
    name: str
    size: int
    totp: str


def _get_downloadable_recording_paths(
    settings: Annotated[Settings, Depends(get_settings)],
    user_home: Annotated[Path, Depends(get_current_user_home)],
) -> list[tuple[Path, int]]:
    if not settings.auth_required:
        return []

    collected: list[tuple[Path, int]] = []

    for rec_dir in sorted(user_home.iterdir()):
        output_path = rec_dir / OUTPUT_FILENAME
        if output_path.is_file():
            collected.append((rec_dir, output_path.stat().st_size))

    return collected

async def get_downloadable_recordings(
    recording_paths: Annotated[list[tuple[Path, int]], Depends(_get_downloadable_recording_paths)],
    download_totp: Annotated[DownloadTotpAuthority, Depends(get_download_totp)]
) -> list[DownloadableRecording]:
    """
    obtain a list of recordings that are downloadable for the authenticated user along with a TOTP
    for each file.
    """
    collected: list[DownloadableRecording] = []

    for recording_path, size in recording_paths:
        output_path = recording_path / OUTPUT_FILENAME
        totp = download_totp.generate(output_path)

        collected.append(
            DownloadableRecording(
                name=recording_path.name,
                size=size,
                totp=totp
            )
        )

    return collected
