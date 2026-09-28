# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring

from typing import Any

from pydantic import ValidationError
import pytest

from ise_record.settings import Settings, SmtpSettings

# aiosmtplib raises ValueError("The start_tls and use_tls options are not compatible.") when
# it is handed both, which would surface as a failed report long after the misconfiguration
# was introduced -- and only for deployments that send mail at all. The validator moves that
# to startup, where it is the operator who just edited the variables who sees it.


def smtp(**overrides: Any) -> SmtpSettings:
    return SmtpSettings(server="mail.example.edu", sender="ise-record@example.edu", **overrides)


@pytest.mark.parametrize(
    "starttls,use_tls",
    [
        (None, False),  # opportunistic: STARTTLS if the relay advertises it
        (True, False),  # STARTTLS required, usually port 587
        (False, False),  # plaintext, never upgraded
        (False, True),  # implicit TLS, usually port 465, with STARTTLS explicitly off
        (None, True),  # implicit TLS; aiosmtplib skips STARTTLS when use_tls is set
    ],
)
def test_a_workable_transport_security_combination_is_accepted(
    starttls: bool | None, use_tls: bool
):
    settings = smtp(starttls=starttls, use_tls=use_tls)

    assert (settings.starttls, settings.use_tls) == (starttls, use_tls)


def test_both_transport_security_modes_at_once_are_rejected():
    with pytest.raises(ValidationError) as caught:
        smtp(starttls=True, use_tls=True)

    assert "mutually exclusive" in str(caught.value)


def test_the_rejection_points_at_the_variable_that_has_to_change():
    # the message names neither field, so this location is what tells an operator which of
    # the two ISE_RECORD_SMTP_* variables to go and unset
    with pytest.raises(ValidationError) as caught:
        smtp(starttls=True, use_tls=True)

    assert caught.value.errors()[0]["loc"] == ("use_tls",)


def test_the_rejection_does_not_echo_the_smtp_password():
    # pydantic attaches the validator's input to the error, and a model-wide validator would
    # put the whole settings dict -- password included -- into the startup traceback
    with pytest.raises(ValidationError) as caught:
        smtp(starttls=True, use_tls=True, username="ise-recorder", password="hunter2")

    assert "hunter2" not in str(caught.value)


def test_the_conflict_is_caught_when_it_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ISE_RECORD_AUTH", "disabled")
    monkeypatch.setenv("ISE_RECORD_SMTP_SERVER", "mail.example.edu")
    monkeypatch.setenv("ISE_RECORD_SMTP_SENDER", "ise-record@example.edu")
    monkeypatch.setenv("ISE_RECORD_SMTP_STARTTLS", "true")
    monkeypatch.setenv("ISE_RECORD_SMTP_USE_TLS", "true")

    with pytest.raises(ValidationError) as caught:
        Settings()

    assert caught.value.errors()[0]["loc"] == ("smtp", "use_tls")


def test_starttls_is_left_opportunistic_unless_it_is_configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ISE_RECORD_AUTH", "disabled")
    monkeypatch.setenv("ISE_RECORD_SMTP_SERVER", "mail.example.edu")
    monkeypatch.setenv("ISE_RECORD_SMTP_SENDER", "ise-record@example.edu")

    settings = Settings()

    assert settings.smtp is not None
    # None, not False: aiosmtplib reads that as "upgrade the connection if the relay
    # advertises STARTTLS", where False would pin an unconfigured deployment to plaintext
    assert settings.smtp.starttls is None
    assert settings.smtp.use_tls is False


# --- authentication is on unless it is turned off --------------------------
#
# An open backend lets anyone who can reach it write to its disk and queue ffmpeg jobs. So
# a deployment that says nothing about authentication does not start, rather than starting
# open: running without it takes ISE_RECORD_AUTH=disabled, written down on purpose. These go
# through the environment, the way a deployment configures it, and conftest has cleared it.

OIDC_ENVIRONMENT = {
    "ISE_RECORD_OIDC_PROVIDER_URL": "https://idp.example.edu/realms/ise",
    "ISE_RECORD_OIDC_AUDIENCE": "ise-recorder-api",
}


def configure(monkeypatch: pytest.MonkeyPatch, **variables: str) -> None:
    for name, value in variables.items():
        monkeypatch.setenv(name, value)


def test_a_deployment_that_configures_nothing_does_not_start():
    with pytest.raises(ValidationError):
        Settings()


def test_the_app_refuses_to_start_on_an_unconfigured_deployment():
    # the same thing one level up: server.py builds its app from exactly these settings at
    # import time, so this is what `fastapi run` does on a deployment that forgot
    from ise_record.server import create_app  # pylint: disable=import-outside-toplevel

    with pytest.raises(ValidationError):
        create_app()


def test_an_empty_auth_setting_counts_as_unset(monkeypatch: pytest.MonkeyPatch):
    # a compose file or Dockerfile easily ends up with ISE_RECORD_AUTH= and nothing after it;
    # that has to mean the default, as the frontend reads it too, not some invalid third mode
    configure(monkeypatch, ISE_RECORD_AUTH="", **OIDC_ENVIRONMENT)

    assert Settings().auth_required


def test_an_openid_provider_alone_turns_authentication_on(monkeypatch: pytest.MonkeyPatch):
    configure(monkeypatch, **OIDC_ENVIRONMENT)

    settings = Settings()

    assert settings.auth_required
    assert settings.oidc is not None


def test_authentication_can_be_turned_off_explicitly(monkeypatch: pytest.MonkeyPatch):
    configure(monkeypatch, ISE_RECORD_AUTH="disabled")

    assert not Settings().auth_required


def test_turning_authentication_off_with_a_provider_configured_is_refused(
    monkeypatch: pytest.MonkeyPatch,
):
    # someone who copied a deployment that turns it off and then added a provider believes
    # they configured authentication; running open on that belief is the accident this exists
    # to rule out
    configure(monkeypatch, ISE_RECORD_AUTH="disabled", **OIDC_ENVIRONMENT)

    with pytest.raises(ValidationError):
        Settings()


@pytest.mark.parametrize("value", ["none", "off", "OIDC", "Disabled"])
def test_an_unknown_auth_setting_is_refused(monkeypatch: pytest.MonkeyPatch, value: str):
    configure(monkeypatch, ISE_RECORD_AUTH=value, **OIDC_ENVIRONMENT)

    with pytest.raises(ValidationError) as caught:
        Settings()

    # which setting is wrong, not how the message puts it
    assert caught.value.errors()[0]["loc"] == ("auth",)


# --- the limit on parallel postprocessing jobs -----------------------------


def test_one_job_renders_at_a_time_unless_configured_otherwise(monkeypatch: pytest.MonkeyPatch):
    # ffmpeg spreads one render over several cores by itself, so one at a time is the default
    # that cannot overload a machine nobody sized for this
    configure(monkeypatch, ISE_RECORD_AUTH="disabled")

    assert Settings().max_parallel_jobs == 1


def test_the_job_limit_is_read_from_the_environment(monkeypatch: pytest.MonkeyPatch):
    configure(monkeypatch, ISE_RECORD_AUTH="disabled", ISE_RECORD_MAX_PARALLEL_JOBS="4")

    assert Settings().max_parallel_jobs == 4


@pytest.mark.parametrize("value", ["0", "-1"])
def test_a_job_limit_that_would_never_render_anything_is_refused(
    monkeypatch: pytest.MonkeyPatch, value: str
):
    # zero slots would accept every job and render none of them, silently
    configure(monkeypatch, ISE_RECORD_AUTH="disabled", ISE_RECORD_MAX_PARALLEL_JOBS=value)

    with pytest.raises(ValidationError) as caught:
        Settings()

    assert caught.value.errors()[0]["loc"] == ("max_parallel_jobs",)
