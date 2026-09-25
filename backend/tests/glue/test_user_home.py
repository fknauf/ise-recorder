"""
The dependable that hands an endpoint the caller's home directory.

What the directory is called, and the alias beside it, is prepare_user_home_dir's business
and lives in core/test_user_home.py; these cover when it is asked, and what is kept.
"""

# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

from pathlib import Path

from fastapi import HTTPException, Request
import pytest

from ise_record.core.auth import UserInfo
from ise_record.glue.user_home import get_current_user_home
from ise_record.settings import Settings

from ..harness import alias_of, digest_of, home_entries
from .conftest import request_for


@pytest.mark.asyncio
async def test_the_home_directory_is_prepared_under_destdir(
    request_: Request, settings: Settings, tmp_path: Path
):
    home = await get_current_user_home(request_, settings, UserInfo("abc", "lecturer"))

    assert home == tmp_path / digest_of("abc")
    assert home_entries(tmp_path) == {digest_of("abc"), alias_of("lecturer", digest_of("abc"))}


@pytest.mark.asyncio
async def test_an_open_deployment_shares_destdir(open_settings: Settings, tmp_path: Path):
    home = await get_current_user_home(request_for(open_settings), open_settings, None)

    assert home == tmp_path
    assert home_entries(tmp_path) == set()


@pytest.mark.asyncio
async def test_no_user_under_authentication_is_an_internal_error(
    request_: Request, settings: Settings, tmp_path: Path
):
    # get_user_info raises before it would return None here, so this is a guard against a
    # wiring mistake -- and it must not fall back to the shared destdir
    with pytest.raises(HTTPException) as excinfo:
        await get_current_user_home(request_, settings, None)

    assert excinfo.value.status_code == 500
    assert home_entries(tmp_path) == set()


@pytest.mark.asyncio
async def test_a_known_subject_keeps_its_directory_without_preparing_it_again(
    request_: Request, settings: Settings, tmp_path: Path
):
    # the rest of a lecture has to keep landing beside its first chunk, or the recording is
    # split across two directories and the postprocessing job only ever sees one
    first = await get_current_user_home(request_, settings, UserInfo("abc", None))
    second = await get_current_user_home(request_, settings, UserInfo("abc", "lecturer"))

    assert first == second
    # no alias appears mid-lecture either: the second call was answered from the cache
    assert home_entries(tmp_path) == {digest_of("abc")}


@pytest.mark.asyncio
async def test_subjects_get_directories_of_their_own(request_: Request, settings: Settings):
    first = await get_current_user_home(request_, settings, UserInfo("user-a", "same"))
    second = await get_current_user_home(request_, settings, UserInfo("user-b", "same"))

    assert first != second
