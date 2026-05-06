# pylint: disable=line-too-long
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-many-locals
# pylint: disable=protected-access
# pylint: disable=no-member

import os
from pathlib import Path
import tempfile
from unittest.mock import ANY

from fastapi.testclient import TestClient
import pytest
from pytest_mock import MockerFixture

from ise_record.postprocess import Result, ResultReason
from ise_record.server import app, get_settings, _postprocessing_task, PostProcessingJob, Settings # pyright: ignore[reportPrivateUsage]

client = TestClient(app)

@pytest.mark.asyncio
async def test_postprocessing_task_with_report(mocker: MockerFixture):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch("ise_record.server.postprocess_recording", autospec=True, return_value=expected_result)
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    settings = Settings(
        smtp_server="localhost",
        smtp_port=587,
        smtp_local_hostname="smtp.example.de",
        smtp_username="server@example.de",
        smtp_password="supersecure",
        smtp_sender="render@example.de",
        smtp_starttls=True,
        smtp_allowed_domains=["example.de"]
    )

    await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient="lecturer@example.de"),
        settings
    )

    mock_postprocess.assert_called_once_with(Path("data/foo"))
    mock_send.assert_called_once_with(
        ANY,
        hostname="localhost",
        port=587,
        local_hostname="smtp.example.de",
        start_tls=True,
        username="server@example.de",
        password="supersecure"
    )

    sent_report = mock_send.call_args[0][0]

    assert "foo" in sent_report["Subject"]
    assert "render@example.de" == sent_report["From"]
    assert "lecturer@example.de" == sent_report["To"]
    assert "foo/presentation.webm" in sent_report.get_payload()

@pytest.mark.asyncio
async def test_postprocessing_task_no_lecturer(mocker: MockerFixture):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch("ise_record.server.postprocess_recording", autospec=True, return_value=expected_result)
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    settings = Settings(
        smtp_server="localhost",
        smtp_port=587,
        smtp_local_hostname="smtp.example.de",
        smtp_username="server@example.de",
        smtp_password="supersecure",
        smtp_sender="render@example.de",
        smtp_starttls=True,
        smtp_allowed_domains=["example.de"]
    )

    await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient=None),
        settings
    )

    mock_postprocess.assert_called_once_with(Path("data/foo"))
    mock_send.assert_not_called()

@pytest.mark.asyncio
async def test_postprocessing_task_no_smtp_config(mocker: MockerFixture):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch("ise_record.server.postprocess_recording", autospec=True, return_value=expected_result)
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient="lecturer@example.de"),
        Settings()
    )

    mock_postprocess.assert_called_once_with(Path("data/foo"))
    mock_send.assert_not_called()

def test_schedule_postprocessing(mocker: MockerFixture):
    mock_isdir = mocker.patch("os.path.isdir", return_value=True)
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={ "Content-Type": "application/json" },
        json={
            "recording": "foo",
            "recipient": "foo@bar.de"
        }
    )

    assert response.status_code == 202
    mock_isdir.assert_called_once_with(get_settings().destdir / "foo")
    mock_add_task.assert_called_once_with(
        _postprocessing_task, # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient="foo@bar.de"),
        get_settings()
    )

def test_schedule_postprocessing_recipient_omitted(mocker: MockerFixture):
    mock_isdir = mocker.patch("os.path.isdir", return_value=True)
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={ "Content-Type": "application/json" },
        json={
            "recording": "foo"
        }
    )

    assert response.status_code == 202
    mock_isdir.assert_called_once_with(get_settings().destdir / "foo")
    mock_add_task.assert_called_once_with(
        _postprocessing_task, # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient=None),
        get_settings()
    )

def test_schedule_postprocessing_error(mocker: MockerFixture):
    mock_isdir = mocker.patch("os.path.isdir", return_value=False)
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={ "Content-Type": "application/json" },
        json={
            "recording": "foo",
            "recipient": "foo@bar.de"
        }
    )

    assert response.status_code == 400
    mock_isdir.assert_called_once_with(get_settings().destdir / "foo")
    mock_add_task.assert_not_called()

def test_schedule_postprocessing_input_validation(mocker: MockerFixture):
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={ "Content-Type": "application/json" },
        json = {
            "recording": "AND 0 == 0; DROP TABLE important_data; --",
            "recipient": "foo@bar.de"
        }
    )

    assert response.status_code == 422
    mock_add_task.assert_not_called()

def test_schedule_postprocessing_broken_recipient_still_starts_post(mocker: MockerFixture):
    mock_isdir = mocker.patch("os.path.isdir", return_value=True)
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={ "Content-Type": "application/json" },
        json={
            "recording": "foo",
            "recipient": "I made a lot of typos"
        }
    )

    assert response.status_code == 202
    mock_isdir.assert_called_once_with(get_settings().destdir / "foo")
    mock_add_task.assert_called_once_with(
        _postprocessing_task, # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient="I made a lot of typos"),
        get_settings()
    )


def test_chunk_upload():
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"
    sample_size = os.stat(sample_path).st_size

    for ix, fname in [
        (   0, "chunk.0000"),
        (  42, "chunk.0042"),
        (9999, "chunk.9999")
    ]:
        with tempfile.TemporaryDirectory() as tempdir, open(sample_path, "rb") as sample:
            def mock_settings(destdir: Path = Path(tempdir)):
                return Settings(destdir=destdir)
            app.dependency_overrides[get_settings] = mock_settings

            try:
                response = client.post(
                    "/api/chunks",
                    data={
                        "recording": "foo",
                        "track": "stream",
                        "index": str(ix)
                    },
                    files={
                        "chunk": sample
                    }
                )

                target_path = Path(tempdir) / "foo" / "stream" / fname

                assert response.status_code == 201
                assert os.path.isfile(target_path)
                assert os.stat(target_path).st_size == sample_size
            finally:
                del app.dependency_overrides[get_settings]

def test_chunk_upload_input_validation():
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"

    with open(sample_path, "rb") as sample:
        response = client.post(
            "/api/chunks",
            data={
                "recording": "AND 0 == 0; DROP TABLE important_data; --",
                "track": "stream",
                "index": "42"
            },
            files={
                "chunk": sample
            }
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={
                "recording": "foo",
                "track": "AND 0 == 0; DROP TABLE important_data; --",
                "index": "42"
            },
            files={
                "chunk": sample
            }
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={
                "recording": "foo",
                "track": "stream",
                "index": "-1"
            },
            files={
                "chunk": sample
            }
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={
                "recording": "foo",
                "track": "stream",
                "index": "10000"
            },
            files={
                "chunk": sample
            }
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={
                "recording": "foo",
                "track": "stream",
                "index": "42"
            }
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={
                "recording": "AND 0 == 0; DROP TABLE important_data; --",
                "track": "stream",
                "index": "42",
                "nonsense": "poppycock"
            },
            files={
                "chunk": sample
            }
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={
                "recording": "AND 0 == 0; DROP TABLE important_data; --",
                "track": "stream",
                "index": "42"
            },
            files={
                "chunk": sample,
                "nonsense": sample
            }
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={
                "recording": "..",
                "track": "..",
                "index": "42"
            },
            files={
                "chunk": sample
            }
        )

        assert response.status_code == 422


def test_chunk_upload_with_more_digits():
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"
    sample_size = os.stat(sample_path).st_size

    cases: list[tuple[int, int, str | None]] = [
        (     0, 201, "chunk.00000"),
        (    42, 201, "chunk.00042"),
        ( 12345, 201, "chunk.12345"),
        ( 99999, 201, "chunk.99999"),
        (100000, 422, None)
    ]

    for ix, status_code, fname in cases:
        with tempfile.TemporaryDirectory() as tempdir, open(sample_path, "rb") as sample:
            def mock_settings(destdir: Path = Path(tempdir)):
                return Settings(destdir=destdir, chunk_file_digits=5)
            app.dependency_overrides[get_settings] = mock_settings

            try:
                response = client.post(
                    "/api/chunks",
                    data={
                        "recording": "foo",
                        "track": "stream",
                        "index": str(ix)
                    },
                    files={
                        "chunk": sample
                    }
                )

                assert response.status_code == status_code

                if fname is not None:
                    target_path = Path(tempdir) / "foo" / "stream" / fname
                    assert os.path.isfile(target_path)
                    assert os.stat(target_path).st_size == sample_size
            finally:
                del app.dependency_overrides[get_settings]
