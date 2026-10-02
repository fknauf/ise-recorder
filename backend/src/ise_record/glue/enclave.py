"""
Module for user-specific enclaves. Every user has a storage directory of his own and runtime state
associated with the recordings in that directory. In unauthenticated deployments there is just one
enclave that's not associated with a user because there are no users.

In this module, that state is defined and exported as a fastapi dependable.
"""

from dataclasses import dataclass, field
from typing import Annotated

from anyio import Path
from fastapi import Depends, HTTPException, Request, status
from pydantic import Field

from ise_record.core.auth import DownloadTotpAuthority, UserInfo
from ise_record.core.recordings import BusyRecordings, RecordingState
from ise_record.core.user_home import prepare_user_home_dir
from ise_record.glue.auth import get_user_info
from ise_record.settings import get_settings, Settings


@dataclass
class Enclave:
    """
    Runtime state of an enclave: storage directory, currently busy recordings, totp authorities
    """

    home_dir: Path
    busy_recordings: BusyRecordings = field(default_factory=BusyRecordings)
    download_totp: DownloadTotpAuthority = field(default_factory=DownloadTotpAuthority)

    def assert_not_busy(self, recording: str) -> None:
        """Raise a 409 exception if the recording in question is being rerendered or purged"""

        recording_path = self.home_dir / recording

        if (busy_state := self.busy_recordings.classify(recording_path)) is not None:
            if busy_state == RecordingState.RENDERING:
                description = "being rendered"
            elif busy_state == RecordingState.PURGING:
                description = "being purged"
            else:
                description = "busy"

            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"{recording_path.name} is currently {description}.",
            )


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
    key = user_info.stable_digest() if user_info is not None else None

    if key not in enclaves:
        if user_info is None:
            home_dir = settings.destdir
        else:
            home_dir = await prepare_user_home_dir(user_info, settings.destdir)

        return enclaves.setdefault(key, Enclave(home_dir))

    return enclaves[key]


async def get_enclave_by_user_digest(
    request: Request,
    user_digest: Annotated[str, Field(pattern=r"\A[0-9a-f]+\z")],
) -> Enclave | None:
    """Get the enclave associated with the user_digest request parameter"""

    enclaves = request.app.state.enclaves
    if user_digest not in enclaves:
        return None

    return enclaves[user_digest]
