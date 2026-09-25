"""
Where a caller's recordings are kept, and what the directory is called.

The directory is named after the token subject so that it survives a rename in the IdP and
a UserInfo endpoint that answers today but not yesterday; a symlink named after the user
sits beside it so that someone with shell access can tell whose is whose. These cover both
halves.

Where the username comes from is in core/test_auth.py and glue/test_auth.py, and how the
app caches the result per subject is in glue/test_user_home.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from pathlib import Path
from typing import Any

import pytest

from ise_record.core.auth import UserInfo
from ise_record.core.user_home import fs_safe_user_name, prepare_user_home_dir

from ..harness import (
    alias_of,
    digest_of,
    home_entries,
)

# --- directory naming ------------------------------------------------------

SUBJECT_DIGEST = digest_of("abc")


# NAME_MAX on ext4. user_home.py keeps its own, much smaller cap on the username part; this is
# the bound the filesystem imposes on whatever comes out of it.
NAME_MAX_BYTES = 255


def user_for(username: Any) -> UserInfo:
    return UserInfo(sub="abc", preferred_username=username)


async def home_dir_for(tmp_path: Path, username: Any) -> Path:
    """The directory name derived for a username, with the subject held fixed."""
    return await prepare_user_home_dir(user_for(username), tmp_path)


@pytest.mark.asyncio
async def test_a_destination_directory_that_does_not_exist_yet_is_created(tmp_path: Path):
    base_dir = tmp_path / "not" / "there" / "yet"

    home = await prepare_user_home_dir(user_for("lecturer"), base_dir)

    assert home == base_dir / SUBJECT_DIGEST
    assert home.is_dir()


@pytest.mark.parametrize(
    "username,expected_prefix",
    [
        ("lecturer", "lecturer-"),
        ("m.mustermann", "m.mustermann-"),
        ("user@example.com", "user@example.com-"),  # the shape most IdPs actually hand out
        ("mit Leerzeichen", "mit_Leerzeichen-"),  # spaces become separators, not gaps
        ("  padded  ", "padded-"),  # stripped before the interior collapse
        ("zwei  Leerzeichen", "zwei_Leerzeichen-"),  # and a run of them collapses to one
        ("\u00e4 \u00f6 \u00fc", "\u00e4_\u00f6_\u00fc-"),
        ("\u5f20\u4e09", "\u5f20\u4e09-"),  # CJK is carried through intact
        (
            "\u0939\u093f\u0928\u094d\u0926\u0940",
            "\u0939\u093f\u0928\u094d\u0926\u0940-",
        ),  # and so are combining marks, which \\w dropped
        ("a/b", "ab-"),  # the separator goes, the name survives
        ("CON", "CON_-"),  # reserved on Windows, renamed by pathvalidate
    ],
)
@pytest.mark.asyncio
async def test_readable_username_becomes_the_directory_alias(
    username: str, expected_prefix: str, tmp_path: Path
):
    home = await home_dir_for(tmp_path, username)
    expected_alias = tmp_path / f"{expected_prefix}{SUBJECT_DIGEST[:12]}"

    assert home == tmp_path / SUBJECT_DIGEST
    assert home.is_dir()

    assert expected_alias.readlink() == Path(SUBJECT_DIGEST)
    assert home_entries(tmp_path) == {SUBJECT_DIGEST, expected_alias.name}


@pytest.mark.parametrize(
    "username",
    [
        None,  # not a string at all
        ".hidden",  # a readable name, but not one that may lead
        "../../etc/passwd",  # flattened by pathvalidate, and then it may not lead either
    ],
)
@pytest.mark.asyncio
async def test_unusable_username_yields_no_alias_link(username: Any, tmp_path: Path):
    # fs_safe_user_name decides which names are refused, and the table for that is with it
    # below; the behavior under test here is only that a refusal leaves nothing on disk --
    # not a link under a name nobody vetted, and not a home directory somewhere else
    home = await home_dir_for(tmp_path, username)

    assert home == tmp_path / SUBJECT_DIGEST
    assert home_entries(tmp_path) == {SUBJECT_DIGEST}


@pytest.mark.parametrize(
    "username,expected",
    [
        ("Anna\u00a0Schmidt", "Anna_Schmidt-"),  # non-breaking space, as a web form sends it
        ("\u3000\u674e\u3000", "\u674e-"),  # ideographic space, as a CJK IME sends it
        ("a\u2003b", "a_b-"),  # em space
        ("a\tb", "a_b-"),
        ("a\nb", "a_b-"),
    ],
)
@pytest.mark.asyncio
async def test_unicode_whitespace_is_a_separator_like_any_other(
    username: str, expected: str, tmp_path: Path
):
    # \s on a str pattern is Unicode-aware, which is what keeps a pasted U+3000 out of a
    # directory name -- pathvalidate would have left it there
    home = await home_dir_for(tmp_path, username)

    assert home == tmp_path / SUBJECT_DIGEST
    assert home_entries(tmp_path) == {SUBJECT_DIGEST, f"{expected}{SUBJECT_DIGEST[:12]}"}


@pytest.mark.asyncio
async def test_the_directory_name_does_not_depend_on_the_composition_of_the_username(
    tmp_path: Path,
):
    # spelled with escapes: the two forms are indistinguishable on screen, so an editor
    # normalizing this file would turn one half of this test into a copy of the other
    decomposed = "U\u0308bung"
    composed = "\u00dcbung"

    assert decomposed != composed
    assert await home_dir_for(tmp_path, decomposed) == await home_dir_for(tmp_path, composed)

    # one alias, not two: the second call has to recognize the first one's name as its own
    assert home_entries(tmp_path) == {SUBJECT_DIGEST, alias_of("\u00dcbung", SUBJECT_DIGEST)}


@pytest.mark.parametrize(
    "username",
    [
        "lecturer",
        "a/b",
        "\\\\server\\share",
        "a" * 300,
        "\u673a" * 200,
        "\U00020000" * 100,
        "\u00e4 \u00f6 \u00fc",
        "nul\x00byte",
        "%2e%2e%2f",
        "\u3000\u674e\u3000",
        "\u0308mark",
    ],
)
@pytest.mark.asyncio
async def test_alias_name_is_always_a_safe_single_path_segment(username: Any):
    name = await fs_safe_user_name(username)

    assert name, "an empty directory name would put chunks in the destination root"
    assert not name.startswith((".", "-")), "hidden on unix, an option to anything argv-shaped"
    assert "/" not in name and "\x00" not in name
    assert not any(character.isspace() for character in name)
    assert (Path("/data") / name).resolve().parent == Path("/data")

    # the bound that matters is bytes, not characters: NAME_MAX is 255 bytes on ext4 and
    # the 48-character slice can be four bytes a character -- and it is the whole alias,
    # username plus the separator plus twelve digest characters, that has to fit
    assert len(alias_of(name, SUBJECT_DIGEST).encode("utf-8")) <= NAME_MAX_BYTES


@pytest.mark.parametrize(
    "username",
    [
        None,  # not a string at all
        "",
        "   ",
        "\u3000",  # nothing left after stripping
        "...",
        "---",
        "..",
        "-.-.-",
        "..;/",  # nothing usable left at all
        ".hidden",
        ".NET",
        "-rf",
        "-weird",  # a readable name, but not one that may lead
        "../../etc/passwd",  # flattened to "....etcpasswd", so it may not either
        "- - - 81457m4573r 9001 - - -",
    ],
)
@pytest.mark.asyncio
async def test_no_alias_for_broken_usernames(username: Any):
    # a deliberate trade: rather than strip the leading character and keep a readable
    # prefix, the whole alias is dropped. Nothing downstream validates this name -- unlike
    # a recording name, there is no pattern behind it -- so this one check is the entire
    # guarantee, and it is worth keeping obvious. Dropping the alias costs nothing: the
    # home directory does not depend on it.
    assert await fs_safe_user_name(username) is None


@pytest.mark.asyncio
async def test_the_home_directory_survives_a_change_of_username(tmp_path: Path):
    # the point of naming the directory after the subject: whether the IdP renames someone,
    # or merely answers a UserInfo query today that it failed to answer yesterday, the
    # recordings already on disk have to stay where the service will look for them
    before = await prepare_user_home_dir(user_for("lecturer"), tmp_path)

    # an empty cache is a restart: nothing is being read back from the first call
    after = await prepare_user_home_dir(user_for("dozentin"), tmp_path)

    assert before == after == tmp_path / SUBJECT_DIGEST

    # the new alias joins the old one rather than replacing it -- both are readable, and
    # nothing that a shell user or an old log refers to stops resolving
    assert home_entries(tmp_path) == {
        SUBJECT_DIGEST,
        alias_of("lecturer", SUBJECT_DIGEST),
        alias_of("dozentin", SUBJECT_DIGEST),
    }
    assert (tmp_path / alias_of("dozentin", SUBJECT_DIGEST)).readlink() == Path(SUBJECT_DIGEST)


@pytest.mark.asyncio
async def test_an_alias_name_that_is_already_taken_is_left_alone(tmp_path: Path):
    # the name the alias wants is exactly what the release before this one used for the
    # real home directory, so on the first start after an upgrade it is occupied. The
    # recordings under it are not migrated, but the upgrade must not trip over them.
    occupied = tmp_path / alias_of("lecturer", SUBJECT_DIGEST)
    (occupied / "old-recording").mkdir(parents=True)

    home = await prepare_user_home_dir(user_for("lecturer"), tmp_path)

    assert home == tmp_path / SUBJECT_DIGEST
    assert not occupied.is_symlink()
    assert (occupied / "old-recording").is_dir()


@pytest.mark.asyncio
async def test_username_collisions_are_separated_by_the_digest(tmp_path: Path):
    # pathvalidate maps several usernames onto one string -- "DOMAIN\\user" and "DOMAINuser"
    # both come out as the latter -- so the digest is the only thing keeping them apart
    first = await prepare_user_home_dir(UserInfo(sub="user-a", preferred_username="same"), tmp_path)
    second = await prepare_user_home_dir(
        UserInfo(sub="user-b", preferred_username="same"), tmp_path
    )

    assert first != second
