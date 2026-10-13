"""
Whom a render's report goes to: the first address fit to mail among those the configured sources
offer, in the order the admin ranked the sources.

What makes an address fit to mail is normalize_recipient's business, in core/test_reporting.py;
that the job mails whoever it is handed, in test_jobs.py. The end-to-end check that the token's
address reaches the job is in test_server.py.
"""

# pylint: disable=missing-function-docstring

from pathlib import Path

import pytest

from ise_record.core.auth import UserInfo
from ise_record.glue.models import RenderRequest
from ise_record.glue.reporting import get_report_recipient
from ise_record.settings import AuthBackend, Settings, SmtpRecipientSource, SmtpSettings

REQUEST = SmtpRecipientSource.REQUEST
OIDC = SmtpRecipientSource.OIDC
OIDC_UNVERIFIED = SmtpRecipientSource.OIDC_UNVERIFIED

ADDRESS = "lecturer@example.edu"
OVERRIDE = "dozentin@example.edu"

VERIFIED = UserInfo(sub="abc", email=ADDRESS, email_verified=True)
UNVERIFIED = UserInfo(sub="abc", email=ADDRESS, email_verified=False)
# Entra, and other providers that never say
UNKNOWN = UserInfo(sub="abc", email=ADDRESS)
NO_ADDRESS = UserInfo(sub="abc", preferred_username="lecturer")


def deployment(
    tmp_path: Path, *sources: SmtpRecipientSource, allowed_domains: tuple[str, ...] = ()
) -> Settings:
    return Settings(
        destdir=tmp_path,
        auth=AuthBackend.DISABLED,
        smtp=SmtpSettings(
            server="localhost",
            sender="render@example.edu",
            recipient_sources=sources,
            allowed_domains=allowed_domains,
        ),
    )


def recipient_for(
    settings: Settings, user: UserInfo | None, recipient: str | None = OVERRIDE
) -> str | None:
    return get_report_recipient(RenderRequest(recipient=recipient), settings, user)


# --- each source on its own ------------------------------------------------


def test_without_smtp_nobody_gets_a_report(tmp_path: Path):
    settings = Settings(destdir=tmp_path, auth=AuthBackend.DISABLED)

    assert recipient_for(settings, VERIFIED) is None


@pytest.mark.parametrize(
    "recipient, expected",
    [
        pytest.param(OVERRIDE, OVERRIDE, id="address"),
        # no exception either: a typo costs the mail, not the render
        pytest.param("I made a lot of typos", None, id="malformed"),
        pytest.param(None, None, id="omitted"),
    ],
)
def test_the_request_offers_what_it_names(
    tmp_path: Path, recipient: str | None, expected: str | None
):
    assert recipient_for(deployment(tmp_path, REQUEST), VERIFIED, recipient) == expected


@pytest.mark.parametrize(
    "user, expected",
    [
        pytest.param(VERIFIED, ADDRESS, id="verified"),
        pytest.param(UNVERIFIED, None, id="unverified"),
        pytest.param(UNKNOWN, None, id="not-said"),
        pytest.param(NO_ADDRESS, None, id="no-address"),
    ],
)
def test_oidc_offers_only_an_address_the_provider_vouches_for(
    tmp_path: Path, user: UserInfo, expected: str | None
):
    # an unverified address may be one anybody typed into their profile, including somebody
    # else's; the admin has to opt into trusting those with oidc-unverified
    assert recipient_for(deployment(tmp_path, OIDC), user) == expected


@pytest.mark.parametrize(
    "user, expected",
    [
        pytest.param(VERIFIED, ADDRESS, id="verified"),
        pytest.param(UNVERIFIED, ADDRESS, id="unverified"),
        pytest.param(UNKNOWN, ADDRESS, id="not-said"),
        pytest.param(NO_ADDRESS, None, id="no-address"),
    ],
)
def test_oidc_unverified_offers_whatever_address_there_is(
    tmp_path: Path, user: UserInfo, expected: str | None
):
    assert recipient_for(deployment(tmp_path, OIDC_UNVERIFIED), user) == expected


@pytest.mark.parametrize("source", [OIDC, OIDC_UNVERIFIED])
def test_an_open_deployment_has_no_address_from_a_provider(
    tmp_path: Path, source: SmtpRecipientSource
):
    assert recipient_for(deployment(tmp_path, source), None) is None


def test_an_open_deployment_still_takes_the_request_s_address(tmp_path: Path):
    # the anonymous deployment that sends reports, which the README describes
    assert recipient_for(deployment(tmp_path, REQUEST, OIDC), None) == OVERRIDE


def test_the_request_is_not_heard_unless_configured(tmp_path: Path):
    # where reports go is the admin's decision, not something a request can override
    assert recipient_for(deployment(tmp_path, OIDC), VERIFIED, "mallory@example.edu") == ADDRESS


@pytest.mark.parametrize("source", [OIDC, OIDC_UNVERIFIED])
def test_the_provider_s_address_has_to_be_in_the_allowed_domains_too(
    tmp_path: Path, source: SmtpRecipientSource
):
    # the provider vouches for whose address it is, not for its being one the relay may mail
    settings = deployment(tmp_path, source, allowed_domains=("uni-hannover.de",))

    assert recipient_for(settings, VERIFIED) is None


def test_the_address_comes_back_normalized(tmp_path: Path):
    settings = deployment(tmp_path, REQUEST, allowed_domains=("example.edu",))

    assert recipient_for(settings, None, "dozentin@Example.EDU") == OVERRIDE


# --- the order of the sources ----------------------------------------------


@pytest.mark.parametrize(
    "sources, expected",
    [
        pytest.param((REQUEST, OIDC), OVERRIDE, id="request-overrides"),
        pytest.param((OIDC, REQUEST), ADDRESS, id="request-as-fallback"),
    ],
)
def test_the_first_configured_source_wins(
    tmp_path: Path, sources: tuple[SmtpRecipientSource, ...], expected: str
):
    assert recipient_for(deployment(tmp_path, *sources), VERIFIED) == expected


def test_the_default_lets_the_request_override_a_verified_address(tmp_path: Path):
    settings = Settings(
        destdir=tmp_path,
        auth=AuthBackend.DISABLED,
        smtp=SmtpSettings(server="localhost", sender="render@example.edu"),
    )

    assert recipient_for(settings, VERIFIED) == OVERRIDE


@pytest.mark.parametrize("recipient", ["", "   ", None])
def test_an_empty_field_is_no_override(tmp_path: Path, recipient: str | None):
    # With the provider's address as a fallback, leaving the field empty no longer means "no
    # report": the report goes to the lecturer's own address.
    settings = deployment(tmp_path, REQUEST, OIDC)

    assert recipient_for(settings, VERIFIED, recipient) == ADDRESS


@pytest.mark.parametrize(
    "recipient",
    [
        pytest.param("x@elsewhere.org", id="domain-not-allowed"),
        pytest.param("I made a lot of typos", id="malformed"),
    ],
)
def test_an_override_unfit_to_mail_falls_back_to_the_provider(tmp_path: Path, recipient: str):
    # the lecturer meant somebody else, but somebody is still better than nobody
    settings = deployment(tmp_path, REQUEST, OIDC, allowed_domains=("example.edu",))

    assert recipient_for(settings, VERIFIED, recipient) == ADDRESS


def test_a_source_with_nothing_to_offer_makes_way_for_the_next(tmp_path: Path):
    settings = deployment(tmp_path, OIDC, REQUEST)

    assert recipient_for(settings, UNVERIFIED) == OVERRIDE


def test_an_unverified_address_is_the_fallback_for_a_verified_one(tmp_path: Path):
    settings = deployment(tmp_path, OIDC, OIDC_UNVERIFIED)

    assert recipient_for(settings, UNVERIFIED) == ADDRESS


def test_without_any_address_fit_to_mail_nobody_gets_a_report(tmp_path: Path):
    settings = deployment(tmp_path, REQUEST, OIDC, allowed_domains=("example.edu",))

    assert recipient_for(settings, UNVERIFIED, "x@elsewhere.org") is None
