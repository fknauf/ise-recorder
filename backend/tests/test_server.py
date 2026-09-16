# pylint: disable=line-too-long
# pylint: disable=missing-class-docstring
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-few-public-methods
# pylint: disable=too-many-locals
# pylint: disable=protected-access
# pylint: disable=no-member
# pylint: disable=redefined-outer-name

import os
from pathlib import Path
from typing import Iterator
from unittest.mock import ANY

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from pytest_mock import MockerFixture

from ise_record.postprocess import Result, ResultReason
from ise_record.server import create_app, _postprocessing_task, PostProcessingJob # pyright: ignore[reportPrivateUsage]
from ise_record.settings import Settings, SmtpSettings

# NAME_MAX on ext4, which is what pathvalidate caps a filename at inside SafeRecording
NAME_MAX_BYTES = 255

@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """ Documented defaults, with a destination directory of this test's own. """
    return Settings(destdir=tmp_path)

@pytest.fixture
def app(settings: Settings) -> FastAPI:
    """
    A fresh application per test.

    Per test rather than per module because the app carries mutable state: the set of
    recordings with a job in flight lives on app.state, and dependency overrides are
    installed on the app too. Sharing one app makes both of those leak between tests, in
    the order-dependent way that only shows up once someone adds the wrong test.
    """
    return create_app(settings)

@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """ A client for the app, inside `with` so the lifespan actually runs. """
    with TestClient(app) as test_client:
        yield test_client

@pytest.mark.asyncio
async def test_postprocessing_task_with_report(mocker: MockerFixture):
    expected_result = Result(reason = ResultReason.SUCCESS, output_file=Path("foo/presentation.webm"))

    mock_postprocess = mocker.patch("ise_record.server.postprocess_recording", autospec=True, return_value=expected_result)
    mock_send = mocker.patch("aiosmtplib.send", autospec=True)

    settings = Settings(
        smtp = SmtpSettings(
            server="localhost",
            port=587,
            local_hostname="smtp.example.de",
            username="server@example.de",
            password="supersecure",
            sender="render@example.de",
            starttls=True,
            allowed_domains=("example.de",)
        )
    )

    await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient="lecturer@example.de"),
        settings,
        ".",
        set()
    )

    mock_postprocess.assert_called_once_with(Path("data/foo"))
    mock_send.assert_called_once_with(
        ANY,
        hostname="localhost",
        port=587,
        local_hostname="smtp.example.de",
        start_tls=True,
        use_tls=False,
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
        smtp = SmtpSettings(
            server="localhost",
            port=587,
            local_hostname="smtp.example.de",
            username="server@example.de",
            password="supersecure",
            sender="render@example.de",
            starttls=True,
            allowed_domains=("example.de",)
        )
    )

    await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient=None),
        settings,
        ".",
        set()
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
        Settings(),
        ".",
        set()
    )

    mock_postprocess.assert_called_once_with(Path("data/foo"))
    mock_send.assert_not_called()

@pytest.mark.asyncio
async def test_a_second_job_for_a_running_recording_is_dropped(mocker: MockerFixture):
    # the frontend retries a job it got no response to, so a duplicate arrives by accident
    # rather than by malice. Two renders would write over each other's assembled tracks.
    mock_postprocess = mocker.patch("ise_record.server.postprocess_recording", autospec=True)

    await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient=None),
        Settings(),
        ".",
        { Path("data/foo") }
    )

    mock_postprocess.assert_not_called()

@pytest.mark.asyncio
async def test_a_job_for_a_different_recording_is_not_dropped(mocker: MockerFixture):
    mock_postprocess = mocker.patch("ise_record.server.postprocess_recording", autospec=True, return_value=Result(reason=ResultReason.SUCCESS, output_file=None))

    await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="bar", recipient=None),
        Settings(),
        ".",
        { Path("data/foo") }
    )

    mock_postprocess.assert_called_once_with(Path("data/bar"))

@pytest.mark.asyncio
async def test_a_finished_job_releases_the_recording(mocker: MockerFixture):
    mocker.patch("ise_record.server.postprocess_recording", autospec=True, return_value=Result(reason=ResultReason.SUCCESS, output_file=None))
    running_jobs: set[Path] = set()

    await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient=None), Settings(), ".", running_jobs
    )

    assert running_jobs == set()

@pytest.mark.asyncio
async def test_a_job_that_blows_up_still_releases_the_recording(mocker: MockerFixture):
    # otherwise one unexpected failure locks that recording out of postprocessing until
    # the server is restarted, and rerender.py is the only way back
    mocker.patch("ise_record.server.postprocess_recording", autospec=True, side_effect=RuntimeError("boom"))
    running_jobs: set[Path] = set()

    with pytest.raises(RuntimeError):
        await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
            PostProcessingJob(recording="foo", recipient=None), Settings(), ".", running_jobs
        )

    assert running_jobs == set()

def test_schedule_postprocessing(mocker: MockerFixture, client: TestClient, app: FastAPI, settings: Settings):
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
    mock_isdir.assert_called_once_with(settings.destdir / "foo")
    mock_add_task.assert_called_once_with(
        _postprocessing_task, # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient="foo@bar.de"),
        settings,
        ".",
        app.state.running_jobs
    )

def test_schedule_postprocessing_recipient_omitted(mocker: MockerFixture, client: TestClient, app: FastAPI, settings: Settings):
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
    mock_isdir.assert_called_once_with(settings.destdir / "foo")
    mock_add_task.assert_called_once_with(
        _postprocessing_task, # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient=None),
        settings,
        ".",
        app.state.running_jobs
    )

def test_schedule_postprocessing_error(mocker: MockerFixture, client: TestClient, settings: Settings):
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
    mock_isdir.assert_called_once_with(settings.destdir / "foo")
    mock_add_task.assert_not_called()

def test_schedule_postprocessing_input_validation(mocker: MockerFixture, client: TestClient):
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

def test_schedule_postprocessing_broken_recipient_still_starts_post(mocker: MockerFixture, client: TestClient, app: FastAPI, settings: Settings):
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
    mock_isdir.assert_called_once_with(settings.destdir / "foo")
    mock_add_task.assert_called_once_with(
        _postprocessing_task, # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient="I made a lot of typos"),
        settings,
        ".",
        app.state.running_jobs
    )


def test_chunk_upload(client: TestClient, settings: Settings):
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"
    sample_size = os.stat(sample_path).st_size

    for ix, fname in [
        (   0, "chunk.0000"),
        (  42, "chunk.0042"),
        (9999, "chunk.9999")
    ]:
        with open(sample_path, "rb") as sample:
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

        target_path = settings.destdir / "foo" / "stream" / fname

        assert response.status_code == 201
        assert os.path.isfile(target_path)
        assert os.stat(target_path).st_size == sample_size

@pytest.mark.parametrize("recording", [
    "GVS_2025-12-21T123456.789Z",
    "\u673a\u5668\u5b66\u4e60\u7b2c\u4e00\u8bb2_2025-12-21T123456.789Z",              # Chinese
    "\u0939\u093f\u0928\u094d\u0926\u0940_\u0935\u094d\u092f\u093e\u0915\u0930\u0923_2025-12-21T123456.789Z",  # Devanagari, which \\w rejected
    "\u00dcbung_3_2025-12-21T123456.789Z",
])
def test_chunk_upload_stores_a_non_latin_recording_name(recording: str, client: TestClient, settings: Settings):
    # the endpoint has to accept what the frontend derives and then actually create the
    # directory: os.makedirs is where a name that passed validation can still fail
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"

    with open(sample_path, "rb") as sample:
        response = client.post(
            "/api/chunks",
            data={"recording": recording, "track": "stream", "index": "0"},
            files={"chunk": sample}
        )

    assert response.status_code == 201
    assert (settings.destdir / recording / "stream" / "chunk.0000").is_file()


def test_chunk_upload_stores_a_decomposed_name_under_one_directory(client: TestClient, settings: Settings):
    # macOS and several IMEs send NFD, so the same lecture can arrive spelled two ways that
    # are identical on screen. Both have to land in the composed directory, or the chunks of
    # one recording end up split across two and the postprocessing job finds half of them.
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"

    for index, recording in enumerate([ "U\u0308bung_2025", "\u00dcbung_2025" ]):
        with open(sample_path, "rb") as sample:
            response = client.post(
                "/api/chunks",
                data={"recording": recording, "track": "stream", "index": str(index)},
                files={"chunk": sample}
            )

        assert response.status_code == 201

    composed = settings.destdir / "\u00dcbung_2025" / "stream"

    assert (composed / "chunk.0000").is_file()
    assert (composed / "chunk.0001").is_file()
    assert sorted(p.name for p in settings.destdir.iterdir()) == [ "\u00dcbung_2025" ]


def test_chunk_upload_truncates_an_overlong_recording_name(client: TestClient, settings: Settings):
    # a client that ignores the frontend's cap must not get a permanent 422 for the length of
    # a lecture, nor an OSError out of os.makedirs. The name is cut to the byte budget instead
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"
    recording = "\u673a" * 200

    with open(sample_path, "rb") as sample:
        response = client.post(
            "/api/chunks",
            data={"recording": recording, "track": "stream", "index": "0"},
            files={"chunk": sample}
        )

    assert response.status_code == 201

    stored = list(settings.destdir.iterdir())

    assert len(stored) == 1
    assert len(stored[0].name.encode("utf-8")) <= NAME_MAX_BYTES
    assert recording.startswith(stored[0].name)
    assert (stored[0] / "stream" / "chunk.0000").is_file()


def test_chunk_upload_input_validation(client: TestClient):
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


def test_chunk_upload_with_more_digits(tmp_path: Path):
    # chunk_file_digits is not the default, so this builds its own app rather than taking
    # the shared fixture
    settings = Settings(destdir=tmp_path, chunk_file_digits=5)
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"
    sample_size = os.stat(sample_path).st_size

    cases: list[tuple[int, int, str | None]] = [
        (     0, 201, "chunk.00000"),
        (    42, 201, "chunk.00042"),
        ( 12345, 201, "chunk.12345"),
        ( 99999, 201, "chunk.99999"),
        (100000, 422, None)
    ]

    with TestClient(create_app(settings)) as client:
        for ix, status_code, fname in cases:
            with open(sample_path, "rb") as sample:
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
                target_path = settings.destdir / "foo" / "stream" / fname
                assert os.path.isfile(target_path)
                assert os.stat(target_path).st_size == sample_size


def test_cors_preflight_jobs_unconfigured(client: TestClient):
    response = client.options(
        "/api/jobs",
        headers={
            "Origin": "http://example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        }
    )
    assert response.status_code == 405
    assert "Access-Control-Allow-Origin" not in response.headers
    assert "Access-Control-Allow-Methods" not in response.headers
    assert "Access-Control-Allow-Headers" not in response.headers

def test_cors_preflight_jobs(tmp_path: Path):
    cors_settings = Settings(destdir=tmp_path, cors_origins=("http://allowed.example.com",))

    with TestClient(create_app(cors_settings)) as cors_client:
        response = cors_client.options(
            "/api/jobs",
            headers={
                "Origin": "http://allowed.example.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            }
        )

    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "http://allowed.example.com"
    assert "POST" in response.headers["Access-Control-Allow-Methods"]
    assert "content-type" in response.headers["Access-Control-Allow-Headers"].lower()

def test_cors_preflight_jobs_forbidden(tmp_path: Path):
    cors_settings = Settings(destdir=tmp_path, cors_origins=("http://allowed.example.com",))

    with TestClient(create_app(cors_settings)) as cors_client:
        response = cors_client.options(
            "/api/jobs",
            headers={
                "Origin": "http://example.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            }
        )

    assert response.status_code == 400
    assert "Access-Control-Allow-Origin" not in response.headers

def test_health_endpoint(client: TestClient):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
