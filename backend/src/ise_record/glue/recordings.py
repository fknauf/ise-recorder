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
from ise_record.core.recordings import (
    RecordingDiskState,
    RecordingInfo,
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
        assert rec.size is not None

        totp = enclave.generate_totp(rec.path.name)
        return DownloadableRecording(name=rec.path.name, size=rec.size, totp=totp)

    recordings = await enclave.recording_classes()

    return RecordingsList.model_construct(
        user=enclave.user_digest(),
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

    with enclave.claim_purging(recording):
        disk_state = await enclave.disk_state(recording)

        if disk_state == RecordingDiskState.NONEXISTENT:
            fail_purge(
                logger.warning,
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Recording {recording} does not exist for this user",
            )

        if await enclave.streaming(recording):
            fail_purge(
                logger.warning,
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Refusing to purge {recording}: it is still being streamed",
            )

        try:
            await asyncio.to_thread(shutil.rmtree, enclave.recording_dir(recording))
        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.exception("Filesystem error")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Filesystem error"
            ) from exc
