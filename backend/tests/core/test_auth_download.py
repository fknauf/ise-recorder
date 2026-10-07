"""
The one-time passwords that stand in for a bearer token on a download link.

A browser following a download link cannot set an Authorization header, so the OTP in the
query string is the whole of the authentication on that request. Everything here is about
what that OTP is scoped to -- one recording of one enclave -- and how long it lasts: the two
properties the scheme rests on.

How the endpoints behave around it (status codes, headers, which recordings a listing
offers) lives in test_server.py, including the scope of an OTP restated over a real request;
this file is about the mechanism itself.
"""

# pylint: disable=missing-function-docstring
# pylint: disable=redefined-outer-name

import datetime

from ise_record.core.auth import DownloadTotpAuthority

# --- the module on its own -------------------------------------------------


def test_an_otp_verifies_for_the_recording_it_was_issued_for():
    download_totp = DownloadTotpAuthority()
    totp = download_totp.generate("GVS_2025")

    assert download_totp.verify(totp, "GVS_2025")


def test_an_otp_does_not_verify_for_a_different_recording():
    # both recordings have been listed, so both have a secret: what turns the OTP away is that
    # the secrets differ, not merely that the other recording has none
    download_totp = DownloadTotpAuthority()
    totp = download_totp.generate("GVS_2025")
    download_totp.generate("PSU_2026")

    assert not download_totp.verify(totp, "PSU_2026")


def test_a_recording_that_was_never_issued_an_otp_verifies_nothing():
    # no generator, so there is nothing to check against. Ten digits of guessing is the
    # point, but only if the absence of a secret is a refusal rather than an accident.
    download_totp = DownloadTotpAuthority()
    unlisted = "never_listed"

    assert not download_totp.verify("0000000000", unlisted)


def test_verifying_for_an_unknown_recording_leaves_no_generator_behind():
    # otherwise an attacker could mint a secret for any recording they name, and every failed
    # guess would also grow the cache for the lifetime of the process
    download_totp = DownloadTotpAuthority()
    download_totp.verify("0000000000", "attacker_named")

    assert not download_totp.factories


def test_the_secret_survives_across_listings():
    download_totp = DownloadTotpAuthority()
    recording = "GVS_2025"

    first = download_totp.generate(recording)
    download_totp.generate(recording)

    # the frontend polls the listing every minute, so a link rendered one poll ago is
    # still on the page when the lecturer clicks it. Rotating the secret per listing would
    # break exactly that click, and only sometimes.
    assert download_totp.verify(first, recording)


def test_an_otp_is_long_enough_and_short_lived_enough_to_carry_the_link():
    download_totp = DownloadTotpAuthority()
    recording = "GVS_2025"
    download_totp.generate(recording)

    generator = download_totp.factories[recording]

    # These two numbers are the security margin of the whole scheme: how long a link that
    # leaked -- over a shoulder, through a proxy log, or in the browser history of a
    # shared lecture hall machine -- stays usable, and how much guessing it takes to
    # forge one inside that window.
    assert generator.digits == 10
    assert generator.interval == 120


def test_an_otp_from_the_previous_interval_still_verifies():
    # The frontend refreshes the listing once a minute, so the link on the page can be a
    # minute old -- and that minute may straddle an interval boundary. A check against the
    # current interval alone would turn that click away, for up to half of every interval.
    # One interval back is the far end of that: the page polled just before a boundary, and
    # the click comes just before the next one.
    download_totp = DownloadTotpAuthority()
    recording = "GVS_2025"
    download_totp.generate(recording)

    generator = download_totp.factories[recording]
    # dating an OTP back rather than moving the clock keeps this independent of how the app
    # measures time
    one_interval_ago = datetime.datetime.now(datetime.UTC) - datetime.timedelta(
        seconds=generator.interval
    )

    assert download_totp.verify(generator.at(one_interval_ago), recording)


def test_an_otp_from_two_intervals_ago_no_longer_verifies():
    # one interval of grace and no more: a leaked link stays usable for at most two
    # intervals, i.e. four minutes
    download_totp = DownloadTotpAuthority()
    recording = "GVS_2025"
    download_totp.generate(recording)

    generator = download_totp.factories[recording]
    two_intervals_ago = datetime.datetime.now(datetime.UTC) - datetime.timedelta(
        seconds=2 * generator.interval
    )

    assert not download_totp.verify(generator.at(two_intervals_ago), recording)


def test_a_forgotten_recording_no_longer_verifies_its_otp():
    # a purged recording's links must die with it, including for a lecture that is later
    # recorded under the same name
    download_totp = DownloadTotpAuthority()
    recording = "GVS_2025"
    totp = download_totp.generate(recording)

    download_totp.forget(recording)

    assert not download_totp.verify(totp, recording)
    assert not download_totp.factories


def test_forgetting_a_recording_leaves_the_others_alone():
    download_totp = DownloadTotpAuthority()
    kept = "PSU_2026"
    totp = download_totp.generate(kept)
    download_totp.generate("GVS_2025")

    download_totp.forget("GVS_2025")

    assert download_totp.verify(totp, kept)


def test_forgetting_a_recording_that_never_had_an_otp_is_harmless():
    # an unprocessed recording has no output and so never had a generator; purging it
    # must not fail on the way out
    download_totp = DownloadTotpAuthority()

    download_totp.forget("never_listed")

    assert not download_totp.factories
