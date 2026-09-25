"""
Functionality concerning the per-user home directories where recordings are stored, i.e. to make
sure they're filesystem-safe, stable, and human-readable at the same time.

The general concept here is that there's a stable main directory that's a hex hash of the oidc
subject, and a human-readable symlink to it that's a filesystem-safe mangling of the oidc
preferred_username claim suffixed with the first few characters of the hash so it's unique even
if preferred usernames overlap.
"""

import hashlib
from pathlib import Path
import re
import unicodedata

from pathvalidate import sanitize_filename

from ise_record.core.auth import UserInfo


async def fs_safe_user_name(preferred_username: str | None) -> str | None:
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
    if candidate[:1] in [".", "-", ""]:
        return None

    return candidate


async def prepare_user_home_dir(user_info: UserInfo, base_dir: Path) -> Path:
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
