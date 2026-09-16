# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-many-locals
# pylint: disable=protected-access
# pylint: disable=no-member

from pathlib import Path
from unittest.mock import ANY

import pytest
from pytest_mock import MockerFixture

from ise_record.postprocess import Result, ResultReason
from ise_record.reporting import (
    generate_report,
    normalize_recipient,
    send_report
)
from ise_record.settings import SmtpSettings

def test_normalize_recipient():
    assert normalize_recipient("foo@vss.uni-hannover.de", []) == "foo@vss.uni-hannover.de"
    assert normalize_recipient("Max Mustermann <max.mustermann@vss.uni-hannover.de>", []) is None
    assert normalize_recipient(None, []) is None
    assert normalize_recipient("foo", []) is None

    assert normalize_recipient("foo@vss.uni-hannover.de", [ "sra.uni-hannover.de", "example.com" ]) is None
    assert normalize_recipient("foo@vss.uni-hannover.de", [ "vss.uni-hannover.de" ]) == "foo@vss.uni-hannover.de"
    assert normalize_recipient("foo@vss.uni-hannover.de", [ "uni-hannover.de" ]) == "foo@vss.uni-hannover.de"

def test_generate_report():
    sender = "render@example.de"
    recipient = "lecturer@example.de"
    job_title = "foo_1234"
    result = Result(reason = ResultReason.SUCCESS, output_file = Path("foo/presentation.webm"))

    report = generate_report(sender, recipient, job_title, result)

    assert report["From"] == sender
    assert report["To"] == recipient
    assert job_title in report["Subject"]
    assert job_title in report.get_payload()
    assert "foo/presentation.webm" in report.get_payload()
    assert "Encoding succeeded" in report.get_payload()

def test_generate_report_failure():
    sender = "render@example.de"
    recipient = "lecturer@example.de"
    job_title = "foo_1234"
    result = Result(reason = ResultReason.FAILURE, output_file = None)

    report = generate_report(sender, recipient, job_title, result)

    assert report["From"] == sender
    assert report["To"] == recipient
    assert job_title in report["Subject"]
    assert job_title in report.get_payload()
    assert "Encoding failed" in report.get_payload()

def test_generate_report_missing():
    sender = "render@example.de"
    recipient = "lecturer@example.de"
    job_title = "foo_1234"
    result = Result(reason = ResultReason.MAIN_STREAM_MISSING, output_file = None)

    report = generate_report(sender, recipient, job_title, result)

    assert report["From"] == sender
    assert report["To"] == recipient
    assert job_title in report["Subject"]
    assert job_title in report.get_payload()
    assert "Missing main display stream" in report.get_payload()

def test_generate_report_partial_success():
    sender = "render@example.de"
    recipient = "lecturer@example.de"
    job_title = "foo_1234"
    result = Result(reason = ResultReason.PARTIAL_SUCCESS, output_file = Path("foo/presentation.webm"))

    report = generate_report(sender, recipient, job_title, result)

    assert report["From"] == sender
    assert report["To"] == recipient
    assert job_title in report["Subject"]
    assert job_title in report.get_payload()
    # the lecturer has a usable file but must know it is short, or they will find out
    # only when the recording stops mid-sentence
    assert "incomplete" in report.get_payload()

def test_generate_report_covers_every_result_reason():
    # the match in generate_report has no fallback: a reason it does not handle leaves
    # `message` unbound and raises UnboundLocalError instead of sending a degraded mail.
    # This fails the moment a variant is added without a case for it.
    for reason in ResultReason:
        report = generate_report(
            "render@example.de",
            "lecturer@example.de",
            "foo_1234",
            Result(reason = reason, output_file = None)
        )

        assert str(report.get_payload()).strip() != ""

@pytest.mark.asyncio
async def test_send_report(mocker: MockerFixture):
    sender = "render@example.de"
    recipient = "lecturer@example.de"
    job_title = "foo_1234"
    result = Result(reason = ResultReason.SUCCESS, output_file = Path("foo/presentation.webm"))

    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    smtp_settings = SmtpSettings(
        server = "localhost",
        port = 587,
        local_hostname = "render.example.de",
        starttls = True,
        username = "server@example.de",
        password = "supersecret",
        sender = sender
    )

    await send_report(
        smtp_settings = smtp_settings,
        recipient = recipient,
        job_title = job_title,
        result = result
    )

    report = generate_report(sender, recipient, job_title, result)

    mock_send.assert_called_once_with(
        ANY,
        hostname=smtp_settings.server,
        port = smtp_settings.port,
        local_hostname = smtp_settings.local_hostname,
        start_tls = smtp_settings.starttls,
        use_tls = smtp_settings.use_tls,
        username = smtp_settings.username,
        password = smtp_settings.password
    )

    sent_report = mock_send.call_args.args[0]

    assert sent_report["From"] == report["From"]
    assert sent_report["To"] == report["To"]
    assert sent_report["Subject"] == report["Subject"]
    assert sent_report.get_payload() == report.get_payload()


@pytest.mark.asyncio
@pytest.mark.parametrize("starttls,use_tls", [
    (None, False),    # opportunistic STARTTLS
    (True, False),    # STARTTLS required
    (False, False),   # plaintext
    (False, True),    # implicit TLS
    (None, True),     # implicit TLS, STARTTLS left to aiosmtplib to skip
])
async def test_send_report_forwards_the_transport_security_mode(
    mocker: MockerFixture, starttls: bool | None, use_tls: bool
):
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    smtp_settings = SmtpSettings(
        server = "mail.example.edu",
        sender = "render@example.de",
        starttls = starttls,
        use_tls = use_tls
    )

    await send_report(
        smtp_settings = smtp_settings,
        recipient = "lecturer@example.de",
        job_title = "foo_1234",
        result = Result(reason = ResultReason.SUCCESS, output_file = Path("foo/presentation.webm"))
    )

    assert mock_send.call_args.kwargs["start_tls"] is starttls
    assert mock_send.call_args.kwargs["use_tls"] is use_tls

    # with no port configured aiosmtplib picks one from these two: 465 for implicit TLS, 587
    # for STARTTLS, 25 otherwise. That delegation is what makes the README's table true.
    assert mock_send.call_args.kwargs["port"] is None
