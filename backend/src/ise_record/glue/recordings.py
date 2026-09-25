"""
Lists of recordings for display in the UI as server-side recordings, binned into finished,
rendering, and unprocessed/failed-postprocessing recordings.
"""

from collections import defaultdict
from collections.abc import Callable
import logging
from pathlib import Path
from typing import Annotated, NamedTuple, NoReturn

from fastapi import Depends, HTTPException, status

from ise_record.core.auth import DownloadTotpAuthority, UserInfo
from ise_record.core.postprocess import OUTPUT_FILENAME
from ise_record.core.recordings import (
    classify_all_recordings,
    classify_recording,
    RecordingInfo,
    RecordingState,
)
from ise_record.glue.auth import get_download_totp, get_user_info
from ise_record.glue.jobs import get_running_jobs_snapshot
from ise_record.glue.models import (
    DisplayableRecording,
    DownloadableRecording,
    RecordingsList,
    SafeRecording,
)
from ise_record.glue.user_home import get_current_user_home
from ise_record.settings import get_settings, Settings

logger = logging.getLogger(__name__)


class RecordingClasses(NamedTuple):
    """Recordings sorted into classes depending on their current state of processing"""

    finished: list[RecordingInfo]
    rendering: list[RecordingInfo]
    unprocessed: list[RecordingInfo]


def get_classified_recordings(
    settings: Annotated[Settings, Depends(get_settings)],
    user_home: Annotated[Path, Depends(get_current_user_home)],
    running_jobs: Annotated[frozenset[Path], Depends(get_running_jobs_snapshot)],
) -> RecordingClasses:
    """FastAPI Dependable to get all recordings of the current user with their states"""

    # In unauthenticated mode, the server-side recordings never leave the API.
    if not settings.auth_required:
        return RecordingClasses([], [], [])

    recordings = classify_all_recordings(user_home, running_jobs)
    bins = defaultdict[RecordingState, list[RecordingInfo]](list[RecordingInfo])

    for r in recordings:
        bins[r.state].append(r)

    return RecordingClasses(
        finished=bins[RecordingState.FINISHED],
        rendering=bins[RecordingState.RENDERING],
        unprocessed=bins[RecordingState.UNPROCESSED],
    )


async def get_recordings_list(
    recordings: Annotated[RecordingClasses, Depends(get_classified_recordings)],
    download_totp: Annotated[DownloadTotpAuthority, Depends(get_download_totp)],
    user_home: Annotated[Path, Depends(get_current_user_home)],
) -> RecordingsList:
    """Formats the list of recordings as required for the server endpoint"""

    def downloadable(rec: RecordingInfo) -> DownloadableRecording:
        output_path = rec.path / OUTPUT_FILENAME
        totp = download_totp.generate(output_path)

        assert rec.size is not None

        return DownloadableRecording(name=rec.path.name, size=rec.size, totp=totp)

    return RecordingsList.model_construct(
        user=user_home.name,
        completed=[downloadable(rec) for rec in recordings.finished],
        rendering=[DisplayableRecording(name=rec.path.name) for rec in recordings.rendering],
        unprocessed=[DisplayableRecording(name=rec.path.name) for rec in recordings.unprocessed],
    )


def get_recording_path_for_purge(
    recording: SafeRecording,
    user_info: Annotated[UserInfo | None, Depends(get_user_info)],
    user_home: Annotated[Path, Depends(get_current_user_home)],
    running_jobs: Annotated[frozenset[Path], Depends(get_running_jobs_snapshot)],
) -> Path:
    """
    Checks if the recording parameter is safe for purging, returns it if that is the case and
    throws an appropriate HTTPException otherwise.
    """

    def fail_purge(log: Callable[[str], None], status_code: int, detail: str) -> NoReturn:
        log(detail)
        raise HTTPException(status_code=status_code, detail=detail)

    if user_info is None:
        fail_purge(
            logger.error,
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User is not authenticated",
        )

    logger.info(
        "User %s (sub = %s) is purging recording %s",
        user_info.preferred_username,
        user_info.sub,
        recording,
    )

    recording_path = user_home / recording
    classified_recording = classify_recording(recording_path, running_jobs)

    if classified_recording.state == RecordingState.NONEXISTENT:
        fail_purge(
            logger.warning,
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Recording {recording} does not exist for this user",
        )

    if not classified_recording.state in {RecordingState.FINISHED, RecordingState.UNPROCESSED}:
        fail_purge(
            logger.warning,
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Recording {recording} is in use and currently not purgeable",
        )

    return recording_path
