"""
It's not possible to attach a bearer token to requests that come from browsers when the user clicks
a download link, at least not without a whole lot of hubbub involving service workers that
intercept the request in-flight and modify it, which becomes ugly real fast.

So instead, when the frontend asks which recordings are downloadable, we generate a one-time
password for each file that the frontend can attach as a GET parameter to the link. Frontend
refreshes the list of recordings regularly, and each time gets new TOTPs.

This module is concerned with generating and validating the TOTPs.
"""

import hashlib
import logging
from pathlib import Path
from typing import Annotated, Any, NamedTuple

from fastapi import Depends, Request
import pyotp

from .postprocess import OUTPUT_FILENAME
from .settings import Settings, get_settings
from .user_home import get_current_user_home

logger = logging.getLogger(__name__)

def _recording_key(file_path: Path) -> str:
    return f"{str(file_path.absolute())}"

def _totp_factories(app_state: Any) -> dict[str, pyotp.TOTP]:
    factories = getattr(app_state, "download_totp_factories", None)

    if factories is None:
        factories = dict[str, pyotp.TOTP]()
        app_state.download_totp_factories = factories

    return factories

def _generate_download_totp(file_path: Path, app_state: Any) -> str:
    key = _recording_key(file_path)
    factories = _totp_factories(app_state)

    # Cache a TOTP factory in the application state the first time an OTP is generated for the file
    if key in factories:
        totp = factories[key]
    else:
        totp = pyotp.TOTP(
            pyotp.random_base32(),
            digits=10,
            digest=hashlib.sha3_256,
            interval=120
        )
        factories[key] = totp

    return totp.now()

def verify_download_totp(totp: str, file_path: Path, app_state: Any) -> bool:
    """ Verify that a TOTP is valid for the download of the specified file """

    key = _recording_key(file_path)
    factories = _totp_factories(app_state)

    if key not in factories:
        return False

    return factories[key].verify(totp)

class DownloadableRecording(NamedTuple):
    """ Per-downloadable-file information for the frontend """
    name: str
    size: int
    totp: str

def get_downloadable_recordings(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    user_home: Annotated[Path, Depends(get_current_user_home)]
) -> list[DownloadableRecording]:
    """
    obtain a list of recordings that are downloadable for the authenticated user along with a TOTP
    for each file.
    """
    if not settings.auth_required:
        return []

    collected: list[DownloadableRecording] = []

    for recording_path in sorted(user_home.iterdir()):
        candidate = recording_path / OUTPUT_FILENAME

        if candidate.is_file():
            totp = _generate_download_totp(candidate, request.app.state)

            collected.append(
                DownloadableRecording(
                    name=recording_path.name,
                    size=candidate.stat().st_size,
                    totp=totp
                )
            )

    return collected
