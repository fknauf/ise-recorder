"""
FastAPI dependables to do with download totp authentication
"""

from fastapi import Request
from ise_record.core.download_totp import DownloadTotpAuthority


async def get_download_totp(request: Request) -> DownloadTotpAuthority:
    """ FastAPI dependable to obtain the TOTP authority """
    return request.app.state.download_totp
