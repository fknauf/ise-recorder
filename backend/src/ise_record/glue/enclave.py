"""
Module for user-specific enclaves. Every user has a storage directory of his own and runtime state
associated with the recordings in that directory. In unauthenticated deployments there is just one
enclave that's not associated with a user because there are no users.

In this module, that state is defined and exported as a fastapi dependable.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from pydantic import Field

from ise_record.core.auth import DownloadTotpAuthority, UserInfo
from ise_record.core.user_home import prepare_user_home_dir
from ise_record.glue.auth import get_user_info
from ise_record.settings import get_settings, Settings


@dataclass
class Enclave:
    """Runtime state of an enclave: storage directory, currently running jobs, totp authorities"""

    home_dir: Path
    running_jobs: set[Path] = field(default_factory=set[Path])
    download_totp: DownloadTotpAuthority = field(default_factory=DownloadTotpAuthority)

    def running_jobs_snapshot(self) -> frozenset[Path]:
        """Snapshot of a user's running job, stable across awaits"""
        return frozenset(self.running_jobs)


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
