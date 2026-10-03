"""
Module for user-specific enclaves. Every user has a storage directory of his own and runtime state
associated with the recordings in that directory. In unauthenticated deployments there is just one
enclave that's not associated with a user because there are no users.

In this module, that state is defined and exported as a fastapi dependable.
"""

from collections.abc import Callable, Generator
from contextlib import AbstractContextManager, contextmanager
from typing import Annotated

from anyio import Path
from fastapi import Depends, HTTPException, Request, status
from pydantic import Field

from ise_record.core.auth import DownloadTotpAuthority, UserInfo
from ise_record.core.recordings import (
    classify_disk_state,
    RecordingActivity,
    RecordingBusy,
    RecordingClasses,
    RecordingDiskState,
    RecordingInfo,
    RecordingTracker,
)
from ise_record.core.user_home import prepare_user_home_dir
from ise_record.glue.auth import get_user_info
from ise_record.settings import get_settings, Settings


class Enclave:
    """
    Runtime state of an enclave: storage directory, currently busy recordings, totp authorities
    """

    def __init__(self, user_digest: str | None, home_dir: Path) -> None:
        self._user_digest = user_digest
        self._home_dir = home_dir
        self._tracker = RecordingTracker()
        self._download_totp = DownloadTotpAuthority()

    def user_digest(self) -> str | None:
        return self._user_digest

    def recording_dir(self, recording: str) -> Path:
        return self._home_dir / recording

    @contextmanager
    def _claim(
        self, fn: Callable[[Path], AbstractContextManager], recording: str, detail: str
    ) -> Generator[None]:
        try:
            with fn(self.recording_dir(recording)):
                yield
        except RecordingBusy as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Recording {recording} is in use and currently not {detail}",
            ) from exc

    def claim_rendering(self, recording: str) -> AbstractContextManager[None]:
        return self._claim(self._tracker.claim_rendering, recording, "renderable")

    @contextmanager
    def claim_purging(self, recording: str) -> Generator[None]:
        with self._claim(self._tracker.claim_purging, recording, "purgeable"):
            yield
            self._download_totp.forget(recording)

    def claim_upload(self, recording: str) -> AbstractContextManager[None]:
        return self._claim(self._tracker.claim_uploading, recording, "accepting uploads")

    async def disk_state(self, recording: str) -> RecordingDiskState:
        state, _ = await classify_disk_state(self.recording_dir(recording))
        return state

    def activity(self, recording: str) -> RecordingActivity:
        return self._tracker.activity(self.recording_dir(recording))

    async def streaming(self, recording: str) -> bool:
        return await self._tracker.streaming(self.recording_dir(recording))

    async def classify(self, recording: str) -> RecordingInfo:
        return await self._tracker.classify(self.recording_dir(recording))

    async def recording_classes(self) -> RecordingClasses:
        return await self._tracker.recording_classes(self._home_dir)

    def generate_totp(self, recording: str) -> str:
        return self._download_totp.generate(recording)

    def verify_totp(self, totp: str, recording: str) -> bool:
        return self._download_totp.verify(totp, recording)


async def get_enclave(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    user_info: Annotated[UserInfo | None, Depends(get_user_info)],
) -> Enclave:
    """
    Get the enclave associated with the currently authenticated user, or in unauthenticated
    deployments the global enclave.
    """
    if settings.auth_required and user_info is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="auth required but no authenticated user in get_enclave",
        )

    enclaves: dict[str | None, Enclave] = request.app.state.enclaves
    digest = user_info.stable_digest() if user_info is not None else None

    if digest not in enclaves:
        if user_info is None:
            home_dir = settings.destdir
        else:
            home_dir = await prepare_user_home_dir(user_info, settings.destdir)

        return enclaves.setdefault(digest, Enclave(digest, home_dir))

    return enclaves[digest]


async def get_enclave_by_user_digest(
    request: Request,
    user_digest: Annotated[str, Field(pattern=r"\A[0-9a-f]+\z")],
) -> Enclave | None:
    """Get the enclave associated with the user_digest request parameter"""

    enclaves = request.app.state.enclaves
    if user_digest not in enclaves:
        return None

    return enclaves[user_digest]
