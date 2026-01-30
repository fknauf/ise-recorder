import os
from pathlib import Path
import tempfile
from unittest.mock import ANY

import aiosmtplib
import fastapi
from fastapi.testclient import TestClient
from ise_record.postprocess import Result, ResultReason
from ise_record.reporting import SmtpSink
import pytest
import server

client = TestClient(server.app)

@pytest.mark.asyncio
async def test_postprocessing_task_with_report(mocker):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mocker.patch("server.postprocess_recording", autospec=True, return_value=expected_result)
    mocker.patch("aiosmtplib.send", autospec=True)
    mocker.patch("server.settings.smtp_server", "localhost")
    mocker.patch("server.settings.smtp_port", 587)
    mocker.patch("server.settings.smtp_local_hostname", "server.example.de")
    mocker.patch("server.settings.smtp_username", "server@example.de")
    mocker.patch("server.settings.smtp_password", "supersecure")
    mocker.patch("server.settings.smtp_sender", "render@example.de")
    mocker.patch("server.settings.smtp_starttls", True)
    mocker.patch("server.settings.smtp_allowed_domains", [ "example.de" ])

    await server._postprocessing_task(server.PostProcessingJob(recording = "foo", recipient = "lecturer@example.de"))

    server.postprocess_recording.assert_called_once_with(Path("data/foo"))
    aiosmtplib.send.assert_called_once_with(
        ANY,
        hostname="localhost",
        port=587,
        local_hostname="server.example.de",
        start_tls=True,
        username="server@example.de",
        password="supersecure"
    )

    sent_report = aiosmtplib.send.call_args[0][0]

    assert "foo" in sent_report["Subject"]
    assert "render@example.de" == sent_report["From"]
    assert "lecturer@example.de" == sent_report["To"]
    assert "foo/presentation.webm" in sent_report.get_payload()

@pytest.mark.asyncio
async def test_postprocessing_task_no_lecturer(mocker):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mocker.patch("server.postprocess_recording", autospec=True, return_value=expected_result)
    mocker.patch("aiosmtplib.send", autospec=True)
    mocker.patch("server.settings.smtp_server", "localhost")
    mocker.patch("server.settings.smtp_port", 587)
    mocker.patch("server.settings.smtp_local_hostname", "server.example.de")
    mocker.patch("server.settings.smtp_username", "server@example.de")
    mocker.patch("server.settings.smtp_password", "supersecure")
    mocker.patch("server.settings.smtp_sender", "render@example.de")
    mocker.patch("server.settings.smtp_starttls", True)
    mocker.patch("server.settings.smtp_allowed_domains", [ "example.de" ])

    await server._postprocessing_task(server.PostProcessingJob(recording = "foo", recipient = None))

    server.postprocess_recording.assert_called_once_with(Path("data/foo"))
    aiosmtplib.send.assert_not_called()

@pytest.mark.asyncio
async def test_postprocessing_task_no_smtp_config(mocker):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mocker.patch("server.postprocess_recording", autospec=True, return_value=expected_result)
    mocker.patch("aiosmtplib.send", autospec=True)

    await server._postprocessing_task(server.PostProcessingJob(recording = "foo", recipient = "lecturer@example.de"))

    server.postprocess_recording.assert_called_once_with(Path("data/foo"))
    aiosmtplib.send.assert_not_called()

def test_schedule_postprocessing(mocker):
    mocker.patch("os.path.isdir", return_value=True)
    mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={ "Content-Type": "application/json" },
        json={
            "recording": "foo",
            "recipient": "foo@bar.de"
        }
    )

    assert response.status_code == 202
    os.path.isdir.assert_called_once_with(server.settings.destdir / "foo")
    fastapi.BackgroundTasks.add_task.assert_called_once_with(
        server._postprocessing_task,
        server.PostProcessingJob(recording="foo", recipient="foo@bar.de")
    )

def test_schedule_postprocessing_error(mocker):
    mocker.patch("os.path.isdir", return_value=False)
    mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={ "Content-Type": "application/json" },
        json={
            "recording": "foo",
            "recipient": "foo@bar.de"
        }
    )

    assert response.status_code == 400
    os.path.isdir.assert_called_once_with(server.settings.destdir / "foo")
    fastapi.BackgroundTasks.add_task.assert_not_called()

def test_chunk_upload(mocker):
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"
    sample_size = os.stat(sample_path).st_size

    with tempfile.TemporaryDirectory() as tempdir, open(sample_path, "rb") as sample:
        mocker.patch("server.settings.destdir", Path(tempdir))

        response = client.post(
            "/api/chunks",
            data={
                "recording": "foo",
                "track": "stream",
                "index": 42
            },
            files={
                "chunk": sample
            }
        )

        target_path = Path(tempdir) / "foo" / "stream" / "chunk.0042"

        assert response.status_code == 201
        assert os.path.isfile(target_path)
        assert os.stat(target_path).st_size == sample_size
