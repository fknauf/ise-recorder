import hashlib
from pathlib import Path
import re
from typing import Annotated
import unicodedata

from fastapi import Depends, Request, HTTPException, status
from pathvalidate import sanitize_filename

from .auth import get_user_info, UserInfo
from .settings import get_settings, Settings

async def fs_safe_user_name(
        preferred_username: str | None
) -> str | None:
    """
    Tries to create a file-system-safe, human-readable identifier for the user for use in a symlink
    to the cryptic digest dir so someone with shell access can identify user homes.
    """

    if preferred_username is None:
        return None

    normalized_user = re.sub(r"\s+", "_", unicodedata.normalize("NFC", preferred_username).strip())
    candidate = sanitize_filename(normalized_user, platform="universal")[:48]

    # filter out hacky user names, i.e. hidden, empty, or looks like a cmdline argument
    # Bail out rather than try to fix because just removing these breaks file name sanitation, at
    # least on Windows: -COM -> COM hits a reserved file name.
    if candidate[:1] in [ ".", "-", "" ]:
        return None

    return candidate

async def prepare_user_home_dir(
        user_info: UserInfo,
        base_dir: Path
) -> Path:
    """
    Prepare a stable (even when user info in the OIDC changes), user-specific home directory, and
    also create a human-readable symlink to it that a shell user can use to identify which stable
    dir belongs to which user.

    :return path to the stable home directory.
    """
    # Infer the stable directory name from the token subject
    digest = hashlib.sha3_256(user_info.sub.encode("utf-8")).hexdigest()
    stable_home = base_dir / digest
    stable_home.mkdir(exist_ok=True, parents=True)

    prefix = await fs_safe_user_name(user_info.preferred_username)

    # if username can't be obtained, leave it. Otherwise, append part of the digest to make it
    # unique, then make it a symlink to the stable directory name.
    if prefix is not None:
        human_readable_home = base_dir / f"{prefix}-{digest[:12]}"
        if not human_readable_home.exists(follow_symlinks=False):
            human_readable_home.symlink_to(stable_home.name, target_is_directory=True)

    return stable_home

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

    cached_home_dirs: dict[str, Path] | None = getattr(request.app.state, "cached_home_dirs", None)

    if cached_home_dirs is None:
        cached_home_dirs = dict[str, Path]()
        request.app.state.cached_home_dirs = cached_home_dirs
    elif user_info.sub in cached_home_dirs:
        # If we already know the home dir, no preparation needed.
        return cached_home_dirs[user_info.sub]

    user_home = await prepare_user_home_dir(
        user_info,
        settings.destdir,
    )

    cached_home_dirs[user_info.sub] = user_home
    return user_home
