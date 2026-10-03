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
        """stable identifier for a user. None in unauthenticated deployments"""
        return self._user_digest

    def recording_dir(self, recording: str) -> Path:
        """The path where a recording is stored in this enclave"""
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
        """
        context manager that marks a recording as rendering. Will throw 409 if the recording is
        in an incompatible state.
        """
        return self._claim(self._tracker.claim_rendering, recording, "renderable")

    @contextmanager
    def claim_purging(self, recording: str) -> Generator[None]:
        """
        context manager that marks a recording as being purged. Will throw 409 if the recording is
        in an incompatible state.
        """
        with self._claim(self._tracker.claim_purging, recording, "purgeable"):
            yield
            self._download_totp.forget(recording)

    def claim_upload(self, recording: str) -> AbstractContextManager[None]:
        """
        context manager that marks a recording as accepting an upload. Will throw 409 if the
        recording is in an incompatible state.
        """
        return self._claim(self._tracker.claim_uploading, recording, "accepting uploads")

    async def disk_state(self, recording: str) -> RecordingDiskState:
        """Determine the on-disk state of a recording"""
        state, _ = await classify_disk_state(self.recording_dir(recording))
        return state

    def activity(self, recording: str) -> RecordingActivity:
        """
        Determine the activity (if any) that's currently performed on the recording (is it being
        rendered, purged, or accepting a chunk upload?)
        """
        return self._tracker.activity(self.recording_dir(recording))

    async def streaming(self, recording: str) -> bool:
        """
        Determine whether the recording is currently being streamed to the backend, i.e. whether
        we should expect that more chunks could arrive. Heuristic.
        """
        return await self._tracker.streaming(self.recording_dir(recording))

    async def classify(self, recording: str) -> RecordingInfo:
        """
        Collect disk state, activity, streaming state, and size for a recording.
        """
        return await self._tracker.classify(self.recording_dir(recording))

    async def recording_classes(self) -> RecordingClasses:
        """Classify all recordings in this enclave for display/download in the frontend"""
        return await self._tracker.recording_classes(self._home_dir)

    def generate_totp(self, recording: str) -> str:
        """Generate a TOTP for the download of a finished recording"""
        return self._download_totp.generate(recording)

    def verify_totp(self, totp: str, recording: str) -> bool:
        """Verify a TOTP allows for the download of the specified recording"""
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

    # A valid user_digest may not be in enclaves here if a download link is clicked before the
    # frontend requested a listing of downloads (which populates enclaves[user_digest]). In that
    # case it'll not have a valid TOTP anyway, so this is fine.
    if user_digest not in enclaves:
        return None

    return enclaves[user_digest]
