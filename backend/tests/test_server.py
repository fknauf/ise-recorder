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
from urllib.parse import quote
from unittest.mock import ANY

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest
from pytest_mock import MockerFixture

from ise_record.download_totp import verify_download_totp
from ise_record.postprocess import Result, ResultReason
from ise_record.server import create_app, _postprocessing_task, PostProcessingJob # pyright: ignore[reportPrivateUsage]
from ise_record.settings import Settings, SmtpSettings

from .harness import DEFAULT_SUBJECT_DIGEST, digest_of, Provider, upload

# NAME_MAX on ext4, which is what pathvalidate caps a filename at inside SafeRecording
NAME_MAX_BYTES = 255
# Prefix for the route-prefix tests
ROUTE_PREFIX = "/foo"

@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """ Documented defaults, with a destination directory of this test's own. """
    return Settings(destdir=tmp_path)

@pytest.fixture
def app(settings: Settings) -> FastAPI:
    """ A fresh application per test. Necessary because app carries mutable state. """
    return create_app(settings)

@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """ A client for the app, inside `with` so the lifespan actually runs. """
    with TestClient(app) as test_client:
        yield test_client

@pytest.fixture
def prefixed_settings(tmp_path: Path) -> Settings:
    return Settings(destdir=tmp_path, route_prefix=ROUTE_PREFIX)

@pytest.fixture
def prefixed_client(prefixed_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(prefixed_settings)) as test_client:
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
        settings.destdir,
        settings.smtp,
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
        settings.destdir,
        settings.smtp,
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
        Settings().destdir,
        None,
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
        Settings().destdir,
        None,
        { Path("data/foo") }
    )

    mock_postprocess.assert_not_called()

@pytest.mark.asyncio
async def test_a_job_for_a_different_recording_is_not_dropped(mocker: MockerFixture):
    mock_postprocess = mocker.patch("ise_record.server.postprocess_recording", autospec=True, return_value=Result(reason=ResultReason.SUCCESS, output_file=None))

    await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="bar", recipient=None),
        Settings().destdir,
        None,
        { Path("data/foo") }
    )

    mock_postprocess.assert_called_once_with(Path("data/bar"))

@pytest.mark.asyncio
async def test_a_finished_job_releases_the_recording(mocker: MockerFixture):
    mocker.patch("ise_record.server.postprocess_recording", autospec=True, return_value=Result(reason=ResultReason.SUCCESS, output_file=None))
    running_jobs: set[Path] = set()

    await _postprocessing_task( # pyright: ignore[reportPrivateUsage]
        PostProcessingJob(recording="foo", recipient=None), Settings().destdir, None, running_jobs
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
            PostProcessingJob(recording="foo", recipient=None), Settings().destdir, None, running_jobs
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
        settings.destdir,
        settings.smtp,
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
        settings.destdir,
        settings.smtp,
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
        settings.destdir,
        settings.smtp,
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

# An unauthenticated deployment has one shared destination directory, so there is nobody
# to own a recording and nobody to withhold one from. Both endpoints refuse to serve rather
# than hand every lecture to every caller -- these pin which way each of them refuses.

def test_the_completed_listing_is_forbidden_without_authentication(
    client: TestClient, settings: Settings
):
    (settings.destdir / "GVS_2025").mkdir(parents=True)
    (settings.destdir / "GVS_2025" / "presentation.webm").write_bytes(b"video")

    response = client.get("/api/completed")

    assert response.status_code == 403

def test_downloading_is_refused_without_user(
    client: TestClient, settings: Settings
):
    (settings.destdir / "GVS_2025").mkdir(parents=True)
    (settings.destdir / "GVS_2025" / "presentation.webm").write_bytes(b"video")

    response = client.get("/api/completed/GVS_2025")

    assert response.status_code == 404
    assert b"video" not in response.content

def test_health_endpoint(client: TestClient):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "healthy"

@pytest.mark.parametrize("endpoint", [ "/api/chunks", "/api/jobs", "/api/health", "/api/completed" ])
def test_every_endpoint_moves_under_the_prefix(prefixed_client: TestClient, endpoint: str):
    assert prefixed_client.get(f"{ROUTE_PREFIX}{endpoint}").status_code != 404

@pytest.mark.parametrize("endpoint", [ "/api/chunks", "/api/jobs", "/api/health", "/api/completed" ])
def test_nothing_is_left_behind_at_the_unprefixed_path(
    prefixed_client: TestClient, endpoint: str
):
    assert prefixed_client.get(endpoint).status_code == 404

@pytest.mark.parametrize("prefix", [ "foo", "/foo/", "/", " /foo" ])
def test_a_malformed_prefix_is_refused_by_the_settings(tmp_path: Path, prefix: str):
    with pytest.raises(ValidationError):
        Settings(destdir=tmp_path, route_prefix=prefix)

@pytest.mark.parametrize("prefix", [ "", "/foo", "/foo/bar", "/a-b_c" ])
def test_a_well_formed_prefix_is_accepted_and_mounts(tmp_path: Path, prefix: str):
    settings = Settings(destdir=tmp_path, route_prefix=prefix)

    with TestClient(create_app(settings)) as client:
        assert client.get(f"{prefix}/api/health").status_code == 200


# --- the endpoints under authentication ------------------------------------

# Everything above drives a deployment with no provider configured, where every caller
# shares one destination directory. With authentication on, the home directory is a Path
# the dependency hands to the endpoint rather than a segment the endpoint joins onto
# destdir itself -- so these are what show that a caller is confined to their own. How
# that directory gets its name is in test_user_home.py.

def schedule(auth_client: TestClient, token: str | None, recording: str = "foo"):
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return auth_client.post("/api/jobs", headers=headers, json={"recording": recording})


def test_scheduling_a_job_without_a_token_is_rejected(auth_client: TestClient):
    response = schedule(auth_client, None)

    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_a_job_runs_against_the_callers_own_recording(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    mock_postprocess = mocker.patch(
        "ise_record.server.postprocess_recording",
        autospec=True,
        return_value=Result(output_file=None, reason=ResultReason.SUCCESS))

    token = provider.mint()
    assert upload(auth_client, token).status_code == 201

    assert schedule(auth_client, token).status_code == 202

    mock_postprocess.assert_called_once_with(tmp_path / DEFAULT_SUBJECT_DIGEST / "foo")


def test_a_job_cannot_name_another_subjects_recording(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the recording name is the caller's to choose and says nothing about whose it is, so
    # two lecturers naming a lecture alike is ordinary. What keeps them apart is that the
    # name is resolved under the caller's own home and nowhere else.
    mock_postprocess = mocker.patch("ise_record.server.postprocess_recording", autospec=True)

    assert upload(auth_client, provider.mint(sub="user-a")).status_code == 201

    # a decoy at the destination root, so that this is the home directory being honored
    # rather than the recording merely being absent everywhere: an implementation that
    # resolved the name anywhere but under the caller's own home would find this one
    (tmp_path / "foo" / "stream").mkdir(parents=True)

    response = schedule(auth_client, provider.mint(sub="user-b"))

    assert response.status_code == 400
    mock_postprocess.assert_not_called()


# --- the completed-recording endpoints -------------------------------------

# These are the only endpoints that hand a stored name back to the auth_client and then take it
# again as a path segment, so this is where the recording name has to work as an
# identifier: through percent-encoding, through a auth_client that normalizes differently, and
# without becoming a way into somebody else's home directory.

def finish_recording(user_home: Path, recording: str, content: bytes = b"video") -> None:
    """ A recording whose postprocessing ran to completion. """
    (user_home / recording).mkdir(parents=True, exist_ok=True)
    (user_home / recording / "presentation.webm").write_bytes(content)


def list_completed(auth_client: TestClient, token: str | None):
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return auth_client.get("/api/completed", headers=headers)


def download_completed(auth_client: TestClient, user_digest: str, recording: str, totp: str | None):
    params = { "totp": totp } if totp is not None else None
    return auth_client.get(f"/api/completed/{user_digest}/{quote(recording)}", params=params)


def test_listing_completed_recordings_without_a_token_is_rejected(auth_client: TestClient):
    assert list_completed(auth_client, None).status_code == 401


def test_downloading_without_a_totp_is_rejected(auth_client: TestClient):
    assert download_completed(auth_client, "deadbeef", "foo", None).status_code == 422


def test_the_listing_returns_the_recordings_with_size_and_valid_totp(
    auth_client: TestClient,
    provider: Provider,
    tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    finish_recording(home, "PSU_2026")

    response = list_completed(auth_client, provider.mint())

    assert response.status_code == 200
    # the names the auth_client has to send back to /api/completed/{recording}, not the name of
    # the file inside each of them -- which is "presentation.webm" for every recording
    data = response.json()

    assert isinstance(data, dict)
    assert "user" in data
    assert "recordings" in data
    assert isinstance(data["recordings"], list)
    assert len(data["recordings"]) == 2

    assert data["recordings"][0]["name"] == "GVS_2025"
    assert data["recordings"][0]["size"] == 5
    assert verify_download_totp(data["recordings"][0]["totp"], home / "GVS_2025" / "presentation.webm", auth_client.app.state)

    assert data["recordings"][1]["name"] == "PSU_2026"
    assert data["recordings"][1]["size"] == 5
    assert verify_download_totp(data["recordings"][1]["totp"], home / "PSU_2026" / "presentation.webm", auth_client.app.state)


def test_the_listing_leaves_out_recordings_that_are_not_rendered(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "rendered")
    # uploaded but never postprocessed
    (home / "raw" / "stream").mkdir(parents=True)
    # postprocessing that failed partway, which is left on disk deliberately
    (home / "failed").mkdir(parents=True)
    (home / "failed" / "presentation.part.webm").write_bytes(b"half")

    response = list_completed(auth_client, provider.mint())

    assert [ r["name"] for r in response.json()["recordings"] ] == [ "rendered" ]


def test_the_listing_only_shows_the_callers_own_recordings(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / digest_of("user-a"), "mine")
    finish_recording(tmp_path / digest_of("user-b"), "theirs")

    assert [ r["name"] for r in list_completed(auth_client, provider.mint(sub="user-a")).json()["recordings"] ] == [ "mine" ]
    assert [ r["name"] for r in list_completed(auth_client, provider.mint(sub="user-b")).json()["recordings"] ] == [ "theirs" ]


def test_a_completed_recording_can_be_downloaded(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025", b"the rendered lecture")

    server_list = list_completed(auth_client, provider.mint()).json()

    response = download_completed(auth_client, server_list["user"], "GVS_2025", server_list["recordings"][0]["totp"])

    assert response.status_code == 200
    assert response.content == b"the rendered lecture"
    assert response.headers["content-type"] == "video/webm"
    # the file on disk is called presentation.webm for everyone, so the recording name is
    # what the browser has to save it under
    assert response.headers["content-disposition"] == 'attachment; filename="GVS_2025.webm"'


@pytest.mark.parametrize("recording", [
    "Übung_3_2025",                                          # Latin with a diacritic
    "机器学习_2025",                              # Chinese
    "हिन्दी_2025",                  # Devanagari, combining marks
])
def test_a_recording_name_survives_the_round_trip_through_the_url(
    recording: str, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the name is percent-encoded on the way out and decoded on the way back in, and
    # SafeRecording runs over it a second time -- a stored name has to be a fixed point of
    # that validator or the listing offers links that 404
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, recording)
    token = provider.mint()

    server_list = list_completed(auth_client, token).json()

    assert server_list["recordings"][0]["name"] == recording

    response = download_completed(auth_client, server_list["user"], recording, server_list["recordings"][0]["totp"])

    assert response.status_code == 200
    assert response.content == b"video"
    # RFC 5987, because the name does not fit in a quoted ASCII filename
    assert response.headers["content-disposition"] == (
        f"attachment; filename*=utf-8''{quote(recording)}.webm")


def test_a_decomposed_name_downloads_the_composed_recording(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the counterpart of the upload test: macOS sends NFD, the recording was stored under
    # NFC, and SafeRecording's BeforeValidator is what makes the two the same request
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "Übung_2025")

    server_list = list_completed(auth_client, provider.mint()).json()

    response = download_completed(auth_client, server_list["user"], "U\u0308bung_2025", server_list["recordings"][0]["totp"])

    assert response.status_code == 200
    assert response.content == b"video"
