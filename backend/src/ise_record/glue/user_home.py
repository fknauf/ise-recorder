"""
Fastapi dependables to do with user home directories
"""

from pathlib import Path
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from ise_record.core.auth import UserInfo
from ise_record.core.user_home import prepare_user_home_dir
from ise_record.glue.auth import get_user_info
from ise_record.settings import Settings, get_settings


async def get_current_user_home(
        request: Request,
        settings: Annotated[Settings, Depends(get_settings)],
        user_info: Annotated[UserInfo | None, Depends(get_user_info)]
) -> Path:
    """ Resolve the caller's home directory name, rejecting unauthenticated requests. """
    if not settings.auth_required:
        return settings.destdir

    # Should never happen: if settings.auth_required and user is unauthenticated, get_user_info
    # throws, and we never come here.
    if user_info is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not identify user"
        )

    cached_home_dirs: dict[str, Path] = request.app.state.cached_home_dirs

    if user_info.sub in cached_home_dirs:
        # If we already know the home dir, no preparation needed.
        return cached_home_dirs[user_info.sub]

    user_home = await prepare_user_home_dir(
        user_info,
        settings.destdir,
    )

    cached_home_dirs[user_info.sub] = user_home
    return user_home
