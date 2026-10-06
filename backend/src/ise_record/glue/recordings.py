"""
Lists of recordings for display in the UI as server-side recordings, binned into finished,
rendering, and unprocessed/failed-postprocessing recordings.
"""

from collections.abc import Callable
import logging
from typing import NoReturn
from urllib.parse import quote

from fastapi import HTTPException, status

from ise_record.core.auth import UserInfo
from ise_record.core.recordings import (
    RecordingActivity,
    RecordingDiskState,
    RecordingInfo,
)
from ise_record.glue.enclave import Enclave
from ise_record.glue.models import (
    DownloadableRecording,
    RecordingResponse,
    SafeRecording,
    UnfinishedRecording,
)

logger = logging.getLogger(__name__)


def _build_recording_response(info: RecordingInfo, enclave: Enclave) -> RecordingResponse | None:
    if enclave.user_digest() is None:
        return None

    if info.activity == RecordingActivity.RENDERING:
        return UnfinishedRecording.model_construct(state="rendering", name=info.name)

    if (
        info.disk_state == RecordingDiskState.FINISHED
        and info.activity != RecordingActivity.PURGING
    ):
        totp = enclave.generate_totp(info.name)
        download_url = f"downloads/{enclave.user_digest()}/{quote(info.name, safe='')}?totp={totp}"

        return DownloadableRecording.model_construct(
            state="completed",
            name=info.name,
            size=info.size,
            download_url=download_url,
        )

    if (
        info.disk_state == RecordingDiskState.UNPROCESSED
        and info.activity == RecordingActivity.NONE
        and not info.streaming
    ):
        return UnfinishedRecording.model_construct(state="unprocessed", name=info.name)

    return None


async def user_recordings_list(enclave: Enclave) -> list[RecordingResponse]:
    """List of a user's recordings. Only available when auth is configured."""
    infos = await enclave.classify_all()
    infos.sort(key=lambda info: info.name)

    return [rsp for info in infos if (rsp := _build_recording_response(info, enclave)) is not None]


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
            await enclave.purge(recording)
        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.exception("Filesystem error")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Filesystem error"
            ) from exc
