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

from fastapi import Request
import pyotp

logger = logging.getLogger(__name__)

def _recording_key(file_path: Path) -> str:
    return f"{str(file_path.absolute())}"

class DownloadTotpAuthority:
    """
    Collection of per-file TOTP generators/verifiers. Used to generate and verify tokens for
    arbitrary processed recordings.
    """

    def __init__(self):
        self.factories = dict[str, pyotp.TOTP]()

    def generate(self, file_path: Path) -> str:
        """ Generate a TOTP that authorizes the download of a specific processed recording """
        key = _recording_key(file_path)

        # Cache a TOTP factory the first time an OTP is generated for the file
        if key in self.factories:
            totp = self.factories[key]
        else:
            totp = pyotp.TOTP(
                pyotp.random_base32(),
                digits=10,
                digest=hashlib.sha3_256,
                interval=120
            )
            self.factories[key] = totp

        return totp.now()

    def verify(self, totp: str, file_path: Path) -> bool:
        """ Verify that a TOTP is valid for the download of the specified file """

        key = _recording_key(file_path)

        if key not in self.factories:
            return False

        return self.factories[key].verify(totp)

    def forget(self, file_path: Path):
        """ Remove a TOTP factory from the authority. Used when a recording is purged. """

        key = _recording_key(file_path)
        self.factories.pop(key, None)

async def get_download_totp(request: Request) -> DownloadTotpAuthority:
    """ FastAPI dependable to obtain the TOTP authority """
    return request.app.state.download_totp
