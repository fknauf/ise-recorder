"""
The one-time passwords that stand in for a bearer token on a download link.

A browser following a download link cannot set an Authorization header, so the OTP in the
query string is the whole of the authentication on that request. Everything here is about
what that OTP is scoped to and how long it lasts -- the two properties the scheme rests on.

How the endpoints behave around it (status codes, headers, which recordings a listing
offers) lives in test_server.py; this file is about the mechanism itself.
"""

# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

import datetime
from pathlib import Path

from fastapi.testclient import TestClient

from ise_record.download_totp import DownloadTotpAuthority

from .harness import (
    download_totp_of,
    DEFAULT_SUBJECT_DIGEST,
    digest_of,
    download_completed,
    finish_recording,
    list_recordings,
    Provider,
)


# --- the module on its own -------------------------------------------------

def test_an_otp_verifies_for_the_file_it_was_issued_for(tmp_path: Path):
    download_totp = DownloadTotpAuthority()
    totp = download_totp.generate(tmp_path / "GVS_2025" / "presentation.webm")

    assert download_totp.verify(totp, tmp_path / "GVS_2025" / "presentation.webm")


def test_an_otp_does_not_verify_for_a_different_file(tmp_path: Path):
    # two OTPs generated in the same interval would be identical if the files shared a
    # secret, which is the failure this rules out rather than merely the key lookup
    download_totp = DownloadTotpAuthority()
    totp = download_totp.generate(tmp_path / "GVS_2025" / "presentation.webm")

    assert not download_totp.verify(totp, tmp_path / "PSU_2026" / "presentation.webm")


def test_a_file_that_was_never_issued_an_otp_verifies_nothing(tmp_path: Path):
    # no generator, so there is nothing to check against. Ten digits of guessing is the
    # point, but only if the absence of a secret is a refusal rather than an accident.
    download_totp = DownloadTotpAuthority()
    unlisted = tmp_path / "never_listed" / "presentation.webm"

    assert not download_totp.verify("0000000000", unlisted)


def test_verifying_for_an_unknown_file_leaves_no_generator_behind(tmp_path: Path):
    # otherwise an attacker could mint a secret for any path they name, and every failed
    # guess would also grow the cache for the lifetime of the process
    download_totp = DownloadTotpAuthority()
    download_totp.verify("0000000000", tmp_path / "attacker_named" / "presentation.webm")

    assert not download_totp.factories


def test_the_secret_survives_across_listings(tmp_path: Path):
    download_totp = DownloadTotpAuthority()
    path = tmp_path / "GVS_2025" / "presentation.webm"

    first = download_totp.generate(path)
    download_totp.generate(path)

    # the frontend polls the listing every minute, so a link rendered one poll ago is
    # still on the page when the lecturer clicks it. Rotating the secret per listing would
    # break exactly that click, and only sometimes.
    assert download_totp.verify(first, path)


def test_an_otp_is_long_enough_and_short_lived_enough_to_carry_the_link(tmp_path: Path):
    download_totp = DownloadTotpAuthority()
    path = tmp_path / "GVS_2025" / "presentation.webm"
    download_totp.generate(path)

    generator = download_totp.factories[str(path.absolute())]

    # These two numbers are the security margin of the whole scheme: how long a link that
    # leaked -- over a shoulder, through a proxy log, or in the browser history of a
    # shared lecture hall machine -- stays usable, and how much guessing it takes to
    # forge one inside that window.
    assert generator.digits == 10
    assert generator.interval == 120


def test_an_otp_from_an_earlier_interval_no_longer_verifies(tmp_path: Path):
    download_totp = DownloadTotpAuthority()
    path = tmp_path / "GVS_2025" / "presentation.webm"
    download_totp.generate(path)

    generator = download_totp.factories[str(path.absolute())]
    # dating an OTP back rather than moving the clock keeps this independent of how the
    # app measures time
    three_intervals = datetime.timedelta(seconds=3 * generator.interval)
    three_intervals_ago = datetime.datetime.now() - three_intervals
    stale = generator.at(three_intervals_ago)

    assert not download_totp.verify(stale, path)


# --- through the endpoints -------------------------------------------------

# The properties above, restated over a real request, because what the download route
# actually verifies against is a path it assembles from two segments the caller supplies.

def test_a_totp_is_scoped_to_the_one_recording_it_was_issued_for(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    finish_recording(home, "PSU_2026", b"the other lecture")

    server_list = list_recordings(auth_client, provider.mint()).json()
    by_name = { rec["name"]: rec["totp"] for rec in server_list["completed"] }

    response = download_completed(auth_client, server_list["user"], "PSU_2026", by_name["GVS_2025"])

    assert response.status_code == 401
    assert b"the other lecture" not in response.content


def test_a_totp_does_not_open_another_subjects_recording(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / digest_of("user-a"), "shared_name")
    finish_recording(tmp_path / digest_of("user-b"), "shared_name", b"not yours")

    server_list = list_recordings(auth_client, provider.mint(sub="user-a")).json()

    # the user directory is a path segment the caller supplies, so the OTP has to be tied
    # to the full path rather than to the recording name both of them happen to use
    response = download_completed(
        auth_client, digest_of("user-b"), "shared_name", server_list["completed"][0]["totp"]
    )

    assert response.status_code == 401
    assert b"not yours" not in response.content


def test_a_recording_that_was_never_listed_cannot_be_downloaded(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "listed")
    finish_recording(home, "never_listed", b"secret lecture")

    # only one of them is ever listed, so the other never gets a generator
    server_list = list_recordings(auth_client, provider.mint()).json()

    response = download_completed(
        auth_client, server_list["user"], "never_listed", server_list["completed"][0]["totp"]
    )

    assert response.status_code == 401
    assert b"secret lecture" not in response.content


def test_a_totp_from_an_earlier_interval_is_refused_by_the_endpoint(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")

    server_list = list_recordings(auth_client, provider.mint()).json()

    key = str((home / "GVS_2025" / "presentation.webm").absolute())
    generator = download_totp_of(auth_client).factories[key]
    three_intervals = datetime.timedelta(seconds=3 * generator.interval)
    three_intervals_ago = datetime.datetime.now() - three_intervals
    stale = generator.at(three_intervals_ago)

    response = download_completed(auth_client, server_list["user"], "GVS_2025", stale)

    assert response.status_code == 401
    assert b"video" not in response.content
