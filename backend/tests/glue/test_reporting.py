"""
Whom a render's report may go to: the candidates each configured source contributes, in the
order the admin ranked the sources.

Which of the candidates is fit to mail is normalize_recipient's call, in core/test_reporting.py;
that the first fit one gets the report is the job's, in test_jobs.py. The end-to-end check that
the token's address reaches the job is in test_server.py.
"""

# pylint: disable=missing-function-docstring

from pathlib import Path

import pytest

from ise_record.core.auth import UserInfo
from ise_record.core.reporting import pick_recipient
from ise_record.glue.models import RenderRequest
from ise_record.glue.reporting import get_recipient_address_candidates
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


def deployment(tmp_path: Path, *sources: SmtpRecipientSource) -> Settings:
    return Settings(
        destdir=tmp_path,
        auth=AuthBackend.DISABLED,
        smtp=SmtpSettings(server="localhost", sender="render@example.edu", recipient=sources),
    )


def candidates(
    settings: Settings, user: UserInfo | None, recipient: str | None = OVERRIDE
) -> list[str]:
    return get_recipient_address_candidates(RenderRequest(recipient=recipient), settings, user)


# --- each source on its own ------------------------------------------------


def test_without_smtp_nobody_is_a_candidate(tmp_path: Path):
    settings = Settings(destdir=tmp_path, auth=AuthBackend.DISABLED)

    assert not candidates(settings, VERIFIED)


@pytest.mark.parametrize(
    "recipient, expected",
    [
        pytest.param(OVERRIDE, [OVERRIDE], id="address"),
        # checked when the report goes out; a typo costs the mail, not the render
        pytest.param("I made a lot of typos", ["I made a lot of typos"], id="malformed"),
        pytest.param(None, [], id="omitted"),
    ],
)
def test_the_request_contributes_what_it_names(
    tmp_path: Path, recipient: str | None, expected: list[str]
):
    assert candidates(deployment(tmp_path, REQUEST), VERIFIED, recipient) == expected


@pytest.mark.parametrize(
    "user, expected",
    [
        pytest.param(VERIFIED, [ADDRESS], id="verified"),
        pytest.param(UNVERIFIED, [], id="unverified"),
        pytest.param(UNKNOWN, [], id="not-said"),
        pytest.param(NO_ADDRESS, [], id="no-address"),
    ],
)
def test_oidc_contributes_only_an_address_the_provider_vouches_for(
    tmp_path: Path, user: UserInfo, expected: list[str]
):
    # an unverified address may be one anybody typed into their profile, including somebody
    # else's; the admin has to opt into trusting those with oidc-unverified
    assert candidates(deployment(tmp_path, OIDC), user) == expected


@pytest.mark.parametrize(
    "user, expected",
    [
        pytest.param(VERIFIED, [ADDRESS], id="verified"),
        pytest.param(UNVERIFIED, [ADDRESS], id="unverified"),
        pytest.param(UNKNOWN, [ADDRESS], id="not-said"),
        pytest.param(NO_ADDRESS, [], id="no-address"),
    ],
)
def test_oidc_unverified_contributes_whatever_address_there_is(
    tmp_path: Path, user: UserInfo, expected: list[str]
):
    assert candidates(deployment(tmp_path, OIDC_UNVERIFIED), user) == expected


@pytest.mark.parametrize("source", [OIDC, OIDC_UNVERIFIED])
def test_an_open_deployment_has_no_address_from_a_provider(
    tmp_path: Path, source: SmtpRecipientSource
):
    assert not candidates(deployment(tmp_path, source), None)


def test_an_open_deployment_still_takes_the_request_s_address(tmp_path: Path):
    # the anonymous deployment that sends reports, which the README describes
    assert candidates(deployment(tmp_path, REQUEST, OIDC), None) == [OVERRIDE]


def test_the_request_is_not_a_candidate_unless_configured(tmp_path: Path):
    # where reports go is the admin's decision, not something a request can override
    assert candidates(deployment(tmp_path, OIDC), VERIFIED, "mallory@example.edu") == [ADDRESS]


# --- the order of the sources ----------------------------------------------


@pytest.mark.parametrize(
    "sources, expected",
    [
        pytest.param((REQUEST, OIDC), [OVERRIDE, ADDRESS], id="request-overrides"),
        pytest.param((OIDC, REQUEST), [ADDRESS, OVERRIDE], id="request-as-fallback"),
        pytest.param((OIDC, OIDC_UNVERIFIED), [ADDRESS, ADDRESS], id="both-oidc"),
    ],
)
def test_candidates_come_in_the_order_the_sources_are_configured(
    tmp_path: Path, sources: tuple[SmtpRecipientSource, ...], expected: list[str]
):
    assert candidates(deployment(tmp_path, *sources), VERIFIED) == expected


def test_the_default_lets_the_request_override_a_verified_address(tmp_path: Path):
    settings = Settings(
        destdir=tmp_path,
        auth=AuthBackend.DISABLED,
        smtp=SmtpSettings(server="localhost", sender="render@example.edu"),
    )

    assert candidates(settings, VERIFIED) == [OVERRIDE, ADDRESS]


# --- what the report ends up with ------------------------------------------


@pytest.mark.parametrize("recipient", ["", "   ", None])
def test_an_empty_field_is_no_override(tmp_path: Path, recipient: str | None):
    # With the provider's address as a fallback, leaving the field empty no longer means "no
    # report": the report goes to the lecturer's own address.
    settings = deployment(tmp_path, REQUEST, OIDC)

    assert pick_recipient(candidates(settings, VERIFIED, recipient), []) == ADDRESS


def test_an_override_outside_the_allowed_domains_falls_back_to_the_provider(tmp_path: Path):
    # the lecturer meant somebody else, but somebody is still better than nobody
    settings = deployment(tmp_path, REQUEST, OIDC)

    chosen = pick_recipient(candidates(settings, VERIFIED, "x@elsewhere.org"), ["example.edu"])

    assert chosen == ADDRESS
