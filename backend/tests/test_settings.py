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
    monkeypatch.setenv("ISE_RECORD_SMTP_SERVER", "mail.example.edu")
    monkeypatch.setenv("ISE_RECORD_SMTP_SENDER", "ise-record@example.edu")
    monkeypatch.setenv("ISE_RECORD_SMTP_STARTTLS", "true")
    monkeypatch.setenv("ISE_RECORD_SMTP_USE_TLS", "true")

    with pytest.raises(ValidationError) as caught:
        Settings()

    assert caught.value.errors()[0]["loc"] == ("smtp", "use_tls")


def test_starttls_is_left_opportunistic_unless_it_is_configured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ISE_RECORD_SMTP_SERVER", "mail.example.edu")
    monkeypatch.setenv("ISE_RECORD_SMTP_SENDER", "ise-record@example.edu")

    settings = Settings()

    assert settings.smtp is not None
    # None, not False: aiosmtplib reads that as "upgrade the connection if the relay
    # advertises STARTTLS", where False would pin an unconfigured deployment to plaintext
    assert settings.smtp.starttls is None
    assert settings.smtp.use_tls is False
