# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-many-locals
# pylint: disable=protected-access
# pylint: disable=no-member

from pathlib import Path
from unittest.mock import ANY

import aiosmtplib
import pytest

from ise_record.postprocess import Result, ResultReason
from ise_record.reporting import (
    generate_report,
    normalize_recipient,
    send_report,
    SmtpSink
)

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

@pytest.mark.asyncio
async def test_send_report(mocker):
    sender = "render@example.de"
    recipient = "lecturer@example.de"
    job_title = "foo_1234"
    result = Result(reason = ResultReason.SUCCESS, output_file = Path("foo/presentation.webm"))

    mocker.patch("aiosmtplib.send", autospec=True)

    smtp_sink = SmtpSink(
        server = "localhost",
        port = 587,
        local_hostname = "render.example.de",
        starttls = True,
        username = "server@example.de",
        password = "supersecret"
    )

    await send_report(
        smtp_sink = smtp_sink,
        sender = sender,
        recipient = recipient,
        job_title = job_title,
        result = result
    )

    report = generate_report(sender, recipient, job_title, result)

    aiosmtplib.send.assert_called_once_with(
        ANY,
        hostname=smtp_sink.server,
        port = smtp_sink.port,
        local_hostname = smtp_sink.local_hostname,
        start_tls = smtp_sink.starttls,
        username = smtp_sink.username,
        password = smtp_sink.password
    )

    sent_report = aiosmtplib.send.call_args.args[0]

    assert sent_report["From"] == report["From"]
    assert sent_report["To"] == report["To"]
    assert sent_report["Subject"] == report["Subject"]
    assert sent_report.get_payload() == report.get_payload()

@pytest.mark.asyncio
async def test_send_report_no_smtp(mocker):
    sender = "render@example.de"
    recipient = "lecturer@example.de"
    job_title = "foo_1234"
    result = Result(reason = ResultReason.SUCCESS, output_file = Path("foo/presentation.webm"))

    mocker.patch("aiosmtplib.send", autospec=True)

    smtp_sink = SmtpSink(
        server = None,
        port = 0,
        local_hostname = None,
        starttls = False,
        username = None,
        password = None
    )

    await send_report(
        smtp_sink = smtp_sink,
        sender = sender,
        recipient = recipient,
        job_title = job_title,
        result = result
    )

    aiosmtplib.send.assert_not_called()
