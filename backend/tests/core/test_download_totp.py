"""
The one-time passwords that stand in for a bearer token on a download link.

A browser following a download link cannot set an Authorization header, so the OTP in the
query string is the whole of the authentication on that request. Everything here is about
what that OTP is scoped to and how long it lasts -- the two properties the scheme rests on.

How the endpoints behave around it (status codes, headers, which recordings a listing
offers) lives in test_server.py, including the properties below restated over a real request;
this file is about the mechanism itself.
"""

# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

import datetime
from pathlib import Path

from ise_record.core.download_totp import DownloadTotpAuthority


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


def test_a_forgotten_file_no_longer_verifies_its_otp(tmp_path: Path):
    # a purged recording's links must die with it, including for a lecture that is later
    # recorded under the same name
    download_totp = DownloadTotpAuthority()
    path = tmp_path / "GVS_2025" / "presentation.webm"
    totp = download_totp.generate(path)

    download_totp.forget(path)

    assert not download_totp.verify(totp, path)
    assert not download_totp.factories


def test_forgetting_a_file_leaves_the_others_alone(tmp_path: Path):
    download_totp = DownloadTotpAuthority()
    kept = tmp_path / "PSU_2026" / "presentation.webm"
    totp = download_totp.generate(kept)
    download_totp.generate(tmp_path / "GVS_2025" / "presentation.webm")

    download_totp.forget(tmp_path / "GVS_2025" / "presentation.webm")

    assert download_totp.verify(totp, kept)


def test_forgetting_a_file_that_never_had_an_otp_is_harmless(tmp_path: Path):
    # an unprocessed recording has no output and so never had a generator; purging it
    # must not fail on the way out
    download_totp = DownloadTotpAuthority()

    download_totp.forget(tmp_path / "never_listed" / "presentation.webm")

    assert not download_totp.factories
