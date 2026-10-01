"""
Lists of recordings for display in the UI as server-side recordings, binned into finished,
rendering, and unprocessed/failed-postprocessing recordings.
"""

import asyncio
from collections.abc import Callable
import logging
import shutil
from typing import NoReturn

from fastapi import HTTPException, status

from ise_record.core.auth import UserInfo
from ise_record.core.postprocess import OUTPUT_FILENAME
from ise_record.core.recordings import (
    classify_recording,
    recording_classes,
    RecordingInfo,
    RecordingState,
)
from ise_record.glue.enclave import Enclave
from ise_record.glue.models import (
    DisplayableRecording,
    DownloadableRecording,
    RecordingsList,
    SafeRecording,
)

logger = logging.getLogger(__name__)


async def user_recordings_list(enclave: Enclave) -> RecordingsList:
    """List of a user's recordings. Only available when auth is configured."""

    def downloadable(rec: RecordingInfo) -> DownloadableRecording:
        output_path = rec.path / OUTPUT_FILENAME
        totp = enclave.download_totp.generate(output_path)

        assert rec.size is not None

        return DownloadableRecording(name=rec.path.name, size=rec.size, totp=totp)

    recordings = await asyncio.to_thread(
        recording_classes, enclave.home_dir, enclave.busy_recordings.snapshot()
    )

    return RecordingsList.model_construct(
        user=enclave.home_dir.name,
        completed=[downloadable(rec) for rec in recordings.finished],
        rendering=[DisplayableRecording(name=rec.path.name) for rec in recordings.rendering],
        unprocessed=[DisplayableRecording(name=rec.path.name) for rec in recordings.unprocessed],
    )


async def purge_recording(recording: SafeRecording, enclave: Enclave, user_info: UserInfo | None):
    """
    Checks if the recording parameter is safe for purging, purges it if that is the case and
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
        "User %s (sub = %s) is purging %s", user_info.preferred_username, user_info.sub, recording
    )

    recording_path = enclave.home_dir / recording

    # classify once before marking, otherwise we'd classify ourselves as purging and not be able to
    # figure out if we're actually purgeable
    pre_purge_busy_recordings = enclave.busy_recordings.snapshot()
    enclave.busy_recordings.purging.add(recording_path)

    try:
        pre_purge_info = await asyncio.to_thread(
            classify_recording, recording_path, pre_purge_busy_recordings
        )

        if pre_purge_info.state == RecordingState.NONEXISTENT:
            fail_purge(
                logger.warning,
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Recording {recording} does not exist for this user",
            )

        if pre_purge_info.state not in {RecordingState.FINISHED, RecordingState.UNPROCESSED}:
            fail_purge(
                logger.warning,
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Recording {recording} is in use and currently not purgeable",
            )

        try:
            await asyncio.to_thread(shutil.rmtree, recording_path)
        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.exception("Filesystem error")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Filesystem error"
            ) from exc

        enclave.download_totp.forget(recording_path / OUTPUT_FILENAME)
    finally:
        enclave.busy_recordings.purging.discard(recording_path)
