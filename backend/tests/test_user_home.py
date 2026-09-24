"""
Where a caller's recordings are kept, and what the directory is called.

The directory is named after the token subject so that it survives a rename in the IdP and
a UserInfo endpoint that answers today but not yesterday; a symlink named after the user
sits beside it so that someone with shell access can tell whose is whose. These cover both
halves, plus the UserInfo lookup that supplies the readable name.

Token validation itself is in test_auth.py, and what the endpoints let a caller reach is in
test_server.py.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
import pytest

from ise_record.core.auth import UserInfo
from ise_record.core.user_home import fs_safe_user_name, prepare_user_home_dir
from ise_record.server import create_app
from ise_record.settings import Settings

from .harness import (
    alias_of,
    DEFAULT_SUBJECT,
    DEFAULT_SUBJECT_DIGEST,
    digest_of,
    home_entries,
    Provider,
    upload,
    upload_chunk_path,
)

# --- the chunk endpoint, as the visible end of all this --------------------

def test_chunk_lands_in_a_per_user_directory(auth_client: TestClient, provider: Provider, tmp_path: Path):
    assert upload(auth_client, provider.mint()).status_code == 201

    # the chunk lives under the subject digest, and is reachable through the readable
    # alias as well -- a shell user finding "lecturer-..." has to land on the real data
    assert upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST).is_file()
    assert upload_chunk_path(tmp_path, alias_of("lecturer", DEFAULT_SUBJECT_DIGEST)).is_file()
    assert len(list(tmp_path.rglob("chunk.*"))) == 1


def test_different_subjects_get_different_directories(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    assert upload(auth_client, provider.mint(sub="user-a"), index=0).status_code == 201
    assert upload(auth_client, provider.mint(sub="user-b"), index=1).status_code == 201

    assert upload_chunk_path(tmp_path, digest_of("user-a"), index=0).is_file()
    assert upload_chunk_path(tmp_path, digest_of("user-b"), index=1).is_file()


def test_a_destination_directory_that_does_not_exist_yet_is_created(
    provider: Provider, fresh_auth_settings: Settings
):
    with TestClient(create_app(fresh_auth_settings)) as fresh:
        assert upload(fresh, provider.mint()).status_code == 201

    assert upload_chunk_path(fresh_auth_settings.destdir, DEFAULT_SUBJECT_DIGEST).is_file()



# --- directory naming ------------------------------------------------------

SUBJECT_DIGEST = digest_of("abc")


# NAME_MAX on ext4. auth.py keeps its own, much smaller cap on the username part; this is
# the bound the filesystem imposes on whatever comes out of it.
NAME_MAX_BYTES = 255

def user_for(username: Any) -> UserInfo:
    return UserInfo(sub="abc", preferred_username=username)

async def home_dir_for(tmp_path: Path, username: Any) -> Path:
    """
    The directory name derived for a username, with the subject held fixed.

    A username that is not a string is absent as far as auth.py is concerned, so these
    calls reach the UserInfo endpoint. The provider fixture leaves it unconfigured, which
    is a 404 -- the same digest fallback the old synchronous helper took directly.
    """
    return await prepare_user_home_dir(user_for(username), tmp_path)


@pytest.mark.parametrize("username,expected_prefix", [
    ("lecturer", "lecturer-"),
    ("m.mustermann", "m.mustermann-"),
    ("user@example.com", "user@example.com-"),        # the shape most IdPs actually hand out
    ("mit Leerzeichen", "mit_Leerzeichen-"),          # spaces become separators, not gaps
    ("  padded  ", "padded-"),                        # stripped before the interior collapse
    ("zwei  Leerzeichen", "zwei_Leerzeichen-"),       # and a run of them collapses to one
    ("\u00e4 \u00f6 \u00fc", "\u00e4_\u00f6_\u00fc-"),
    ("\u5f20\u4e09", "\u5f20\u4e09-"),                        # CJK is carried through intact
    ("\u0939\u093f\u0928\u094d\u0926\u0940", "\u0939\u093f\u0928\u094d\u0926\u0940-"),      # and so are combining marks, which \\w dropped
    ("a/b", "ab-"),                                   # the separator goes, the name survives
    ("CON", "CON_-"),                                 # reserved on Windows, renamed by pathvalidate
])
@pytest.mark.asyncio
async def test_readable_username_becomes_the_directory_alias(
    username: str, expected_prefix: str, tmp_path: Path
):
    home = await home_dir_for(tmp_path, username)
    expected_alias = tmp_path / f"{expected_prefix}{SUBJECT_DIGEST[:12]}"

    assert home == tmp_path / SUBJECT_DIGEST
    assert home.is_dir()

    assert expected_alias.readlink() == Path(SUBJECT_DIGEST)
    assert home_entries(tmp_path) == { SUBJECT_DIGEST, expected_alias.name }


@pytest.mark.parametrize("username", [
    None,                    # not a string at all
    ".hidden",               # a readable name, but not one that may lead
    "../../etc/passwd",      # flattened by pathvalidate, and then it may not lead either
])
@pytest.mark.asyncio
async def test_unusable_username_yields_no_alias_link(
    username: Any, tmp_path: Path
):
    # fs_safe_user_name decides which names are refused, and the table for that is with it
    # below; the behavior under test here is only that a refusal leaves nothing on disk --
    # not a link under a name nobody vetted, and not a home directory somewhere else
    home = await home_dir_for(tmp_path, username)

    assert home == tmp_path / SUBJECT_DIGEST
    assert home_entries(tmp_path) == { SUBJECT_DIGEST }


@pytest.mark.parametrize("username,expected", [
    ("Anna\u00a0Schmidt", "Anna_Schmidt-"),    # non-breaking space, as a web form sends it
    ("\u3000\u674e\u3000", "\u674e-"),                 # ideographic space, as a CJK IME sends it
    ("a\u2003b", "a_b-"),                      # em space
    ("a\tb", "a_b-"),
    ("a\nb", "a_b-"),
])
@pytest.mark.asyncio
async def test_unicode_whitespace_is_a_separator_like_any_other(
    username: str, expected: str, tmp_path: Path
):
    # \s on a str pattern is Unicode-aware, which is what keeps a pasted U+3000 out of a
    # directory name -- pathvalidate would have left it there
    home = await home_dir_for(tmp_path, username)

    assert home == tmp_path / SUBJECT_DIGEST
    assert home_entries(tmp_path) == { SUBJECT_DIGEST, f"{expected}{SUBJECT_DIGEST[:12]}" }


@pytest.mark.asyncio
async def test_the_directory_name_does_not_depend_on_the_composition_of_the_username(
    tmp_path: Path
):
    # spelled with escapes: the two forms are indistinguishable on screen, so an editor
    # normalizing this file would turn one half of this test into a copy of the other
    decomposed = "U\u0308bung"
    composed = "\u00dcbung"

    assert decomposed != composed
    assert await home_dir_for(tmp_path, decomposed) == await home_dir_for(tmp_path, composed)

    # one alias, not two: the second call has to recognize the first one's name as its own
    assert home_entries(tmp_path) == { SUBJECT_DIGEST, alias_of("\u00dcbung", SUBJECT_DIGEST) }

@pytest.mark.parametrize("username", [
    "lecturer", "a/b", "\\\\server\\share",
    "a" * 300, "\u673a" * 200, "\U00020000" * 100, "\u00e4 \u00f6 \u00fc", "nul\x00byte",
    "%2e%2e%2f", "\u3000\u674e\u3000",
    "\u0308mark"
])
@pytest.mark.asyncio
async def test_alias_name_is_always_a_safe_single_path_segment(
    username: Any
):
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


@pytest.mark.parametrize("username", [
    None,                                     # not a string at all
    "", "   ", "\u3000",                      # nothing left after stripping
    "...", "---", "..", "-.-.-", "..;/",      # nothing usable left at all
    ".hidden", ".NET", "-rf", "-weird",       # a readable name, but not one that may lead
    "../../etc/passwd",                       # flattened to "....etcpasswd", so it may not either
    "- - - 81457m4573r 9001 - - -",
])
@pytest.mark.asyncio
async def test_no_alias_for_broken_usernames(username: Any):
    # a deliberate trade: rather than strip the leading character and keep a readable
    # prefix, the whole alias is dropped. Nothing downstream validates this name -- unlike
    # a recording name, there is no pattern behind it -- so this one check is the entire
    # guarantee, and it is worth keeping obvious. Dropping the alias costs nothing: the
    # home directory does not depend on it.
    assert await fs_safe_user_name(username) is None


@pytest.mark.asyncio
async def test_the_home_directory_survives_a_change_of_username(
    tmp_path: Path
):
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
async def test_an_alias_name_that_is_already_taken_is_left_alone(
    tmp_path: Path
):
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
    first = await prepare_user_home_dir(
        UserInfo(sub="user-a", preferred_username="same"), tmp_path)
    second = await prepare_user_home_dir(
        UserInfo(sub="user-b", preferred_username="same"), tmp_path)

    assert first != second



# --- the UserInfo fallback -------------------------------------------------

# Kanidm does not put profile claims in an access token even when the profile scope was
# granted, which the spec permits -- identity claims are only promised in the id token and
# at the UserInfo endpoint. So a token without preferred_username is not an error, and
# these cover what auth.py makes of one.

def test_userinfo_is_not_consulted_when_the_token_carries_the_username(
    auth_client: TestClient, provider: Provider
):
    assert upload(auth_client, provider.mint()).status_code == 201

    # the round trip is per user and on the upload path, so not making it is the point
    assert provider.userinfo_fetch_count == 0


def test_username_comes_from_userinfo_when_the_token_omits_it(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")

    assert upload(auth_client, provider.mint(preferred_username=None)).status_code == 201

    assert upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST).is_file()
    assert upload_chunk_path(tmp_path, alias_of("lecturer", DEFAULT_SUBJECT_DIGEST)).is_file()
    assert provider.userinfo_fetch_count == 1


def test_userinfo_is_asked_with_the_callers_access_token(
    auth_client: TestClient, provider: Provider
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")
    token = provider.mint(preferred_username=None)

    assert upload(auth_client, token).status_code == 201

    # the access token is the credential for UserInfo too; nothing else would authorize us
    assert provider.userinfo_authorization == f"Bearer {token}"


def test_userinfo_about_a_different_subject_is_discarded(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # OIDC Core 5.3.2 requires this check: an answer about somebody else would otherwise
    # put this caller's recordings in a directory named after them
    provider.serve_userinfo(sub="somebody-else", preferred_username="mallory")

    assert upload(auth_client, provider.mint(preferred_username=None)).status_code == 201

    assert home_entries(tmp_path) == { DEFAULT_SUBJECT_DIGEST }


@pytest.mark.parametrize("response", [
    (502, "text/html", b"<html><body>502 Bad Gateway</body></html>"),  # a proxy, not the OP
    (403, "application/json", b'{"error":"insufficient_scope"}'),      # profile not granted
    (200, "application/jwt", b"eyJhbGciOiJSUzI1NiJ9.e30.sig"),         # signed UserInfo
    (200, "application/json", b""),                                    # nothing at all
    (200, "application/json", b'["not", "an", "object"]'),             # json, wrong shape
    (200, "application/json", b'{"preferred_username":"lecturer"}'),   # no sub to check
])
def test_unusable_userinfo_falls_back_to_the_digest(
    auth_client: TestClient, provider: Provider, tmp_path: Path, response: tuple[int, str, bytes]
):
    provider.serve_userinfo_raw(*response)

    # a cosmetic directory name is not worth failing an upload over
    assert upload(auth_client, provider.mint(preferred_username=None)).status_code == 201

    assert upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST).is_file()
    # and a name this module could not make sense of is not worth guessing at either
    assert home_entries(tmp_path) == { DEFAULT_SUBJECT_DIGEST }


def test_userinfo_with_a_non_string_username_falls_back_to_the_digest(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username=42)

    assert upload(auth_client, provider.mint(preferred_username=None)).status_code == 201

    assert upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST).is_file()
    assert home_entries(tmp_path) == { DEFAULT_SUBJECT_DIGEST }


def test_unreachable_userinfo_does_not_fail_the_upload(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    provider.serve_userinfo(sub="offline-user", preferred_username="lecturer")
    # minted while the provider is up, and verified afterwards from the cached key set
    token = provider.mint(sub="offline-user", preferred_username=None)
    assert upload(auth_client, provider.mint(), index=0).status_code == 201
    provider.stop()

    assert upload(auth_client, token, index=1).status_code == 201

    assert upload_chunk_path(tmp_path, digest_of("offline-user"), index=1).is_file()
    # the first caller got an alias; this one gets a home directory and nothing else
    assert home_entries(tmp_path) == {
        DEFAULT_SUBJECT_DIGEST,
        alias_of("lecturer", DEFAULT_SUBJECT_DIGEST),
        digest_of("offline-user"),
    }


def test_username_from_userinfo_is_sanitized_like_one_from_the_token(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # UserInfo is a second way into fs_safe_user_name, and must not be a way around it
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="../../etc/passwd")

    assert upload(auth_client, provider.mint(preferred_username=None)).status_code == 201

    assert home_entries(tmp_path) == { DEFAULT_SUBJECT_DIGEST }


def test_userinfo_is_consulted_once_per_subject(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")
    token = provider.mint(preferred_username=None)

    for index in range(3):
        assert upload(auth_client, token, index=index).status_code == 201

    assert provider.userinfo_fetch_count == 1
    assert home_entries(tmp_path) == { DEFAULT_SUBJECT_DIGEST, alias_of("lecturer", DEFAULT_SUBJECT_DIGEST) }


def test_a_recovering_provider_does_not_move_a_directory_already_in_use(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # UserInfo unavailable for the first chunk, so this lecture starts under the digest
    token = provider.mint(preferred_username=None)
    assert upload(auth_client, token, index=0).status_code == 201
    assert home_entries(tmp_path) == { DEFAULT_SUBJECT_DIGEST }

    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")

    # the rest of the lecture has to keep landing beside the first chunk, or the recording
    # is split across two directories and the postprocessing job only ever sees one
    assert upload(auth_client, token, index=1).status_code == 201

    assert home_entries(tmp_path) == { DEFAULT_SUBJECT_DIGEST }
    assert provider.userinfo_fetch_count == 1


# --- a provider that has no UserInfo endpoint ------------------------------

# OIDC Discovery 1.0 lists userinfo_endpoint as RECOMMENDED, not REQUIRED, so its absence
# is not an error and must not take the service down with it.

# Whether discovery records the endpoint at all is in test_auth.py.

def test_tokens_are_still_accepted_without_a_userinfo_endpoint(
    provider: Provider, auth_settings: Settings, tmp_path: Path
):
    provider.advertise_userinfo = False

    with TestClient(create_app(auth_settings)) as started_without_userinfo:
        assert upload(started_without_userinfo, provider.mint()).status_code == 201

    assert home_entries(tmp_path) == { DEFAULT_SUBJECT_DIGEST, alias_of("lecturer", DEFAULT_SUBJECT_DIGEST) }


def test_no_userinfo_endpoint_falls_back_to_the_digest_without_asking(
    provider: Provider, auth_settings: Settings, tmp_path: Path
):
    provider.advertise_userinfo = False
    # served, but never advertised: if the endpoint were guessed at rather than taken from
    # the discovery document, this name would show up in the directory and give it away
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="lecturer")

    with TestClient(create_app(auth_settings)) as started_without_userinfo:
        assert upload(
            started_without_userinfo, provider.mint(preferred_username=None)
        ).status_code == 201

    assert home_entries(tmp_path) == { DEFAULT_SUBJECT_DIGEST }
    assert provider.userinfo_fetch_count == 0
