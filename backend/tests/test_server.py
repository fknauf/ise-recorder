# pylint: disable=line-too-long
# pylint: disable=missing-class-docstring
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=too-few-public-methods
# pylint: disable=too-many-locals
# pylint: disable=too-many-lines
# pylint: disable=protected-access
# pylint: disable=no-member
# pylint: disable=redefined-outer-name

from collections.abc import Iterator
import datetime
import os
from pathlib import Path
from unittest.mock import ANY
from urllib.parse import quote

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest
from pytest_mock import MockerFixture

from ise_record.core.postprocess import Result, ResultReason
from ise_record.glue.jobs import postprocessing_task
from ise_record.server import create_app
from ise_record.settings import Settings

from .harness import (
    abandon_recording,
    alias_of,
    DEFAULT_SUBJECT,
    DEFAULT_SUBJECT_DIGEST,
    digest_of,
    download_completed,
    download_totp_of,
    finish_recording,
    home_entries,
    list_recordings,
    Provider,
    purge,
    running_jobs_of,
    upload,
    upload_chunk_path,
    write_chunks,
)

# NAME_MAX on ext4, which is what pathvalidate caps a filename at inside SafeRecording
NAME_MAX_BYTES = 255
# Prefix for the route-prefix tests
ROUTE_PREFIX = "/foo"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Documented defaults, with a destination directory of this test's own."""
    return Settings(destdir=tmp_path)


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    """A fresh application per test. Necessary because app carries mutable state."""
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """A client for the app, inside `with` so the lifespan actually runs."""
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def prefixed_settings(tmp_path: Path) -> Settings:
    return Settings(destdir=tmp_path, route_prefix=ROUTE_PREFIX)


@pytest.fixture
def prefixed_client(prefixed_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(prefixed_settings)) as test_client:
        yield test_client


def test_schedule_postprocessing(mocker: MockerFixture, client: TestClient, settings: Settings):
    mock_isdir = mocker.patch("os.path.isdir", return_value=True)
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={"Content-Type": "application/json"},
        json={"recording": "foo", "recipient": "foo@bar.de"},
    )

    assert response.status_code == 202
    mock_isdir.assert_called_once_with(settings.destdir / "foo")
    mock_add_task.assert_called_once_with(
        postprocessing_task, settings.destdir / "foo", "foo@bar.de", settings.smtp, ANY
    )
    # the very set the listing reads, not merely an equal one: every empty set is equal to
    # every other, so only identity shows the job is registered where it will be looked for
    assert mock_add_task.call_args.args[4] is running_jobs_of(client, settings.destdir)


def test_schedule_postprocessing_recipient_omitted(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    mock_isdir = mocker.patch("os.path.isdir", return_value=True)
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs", headers={"Content-Type": "application/json"}, json={"recording": "foo"}
    )

    assert response.status_code == 202
    mock_isdir.assert_called_once_with(settings.destdir / "foo")
    mock_add_task.assert_called_once_with(
        postprocessing_task, settings.destdir / "foo", None, settings.smtp, ANY
    )
    # the very set the listing reads, not merely an equal one: every empty set is equal to
    # every other, so only identity shows the job is registered where it will be looked for
    assert mock_add_task.call_args.args[4] is running_jobs_of(client, settings.destdir)


def test_schedule_postprocessing_error(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    mock_isdir = mocker.patch("os.path.isdir", return_value=False)
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={"Content-Type": "application/json"},
        json={"recording": "foo", "recipient": "foo@bar.de"},
    )

    assert response.status_code == 400
    mock_isdir.assert_called_once_with(settings.destdir / "foo")
    mock_add_task.assert_not_called()


def test_schedule_postprocessing_input_validation(mocker: MockerFixture, client: TestClient):
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={"Content-Type": "application/json"},
        json={"recording": "AND 0 == 0; DROP TABLE important_data; --", "recipient": "foo@bar.de"},
    )

    assert response.status_code == 422
    mock_add_task.assert_not_called()


def test_schedule_postprocessing_broken_recipient_still_starts_post(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    mock_isdir = mocker.patch("os.path.isdir", return_value=True)
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(
        "/api/jobs",
        headers={"Content-Type": "application/json"},
        json={"recording": "foo", "recipient": "I made a lot of typos"},
    )

    assert response.status_code == 202
    mock_isdir.assert_called_once_with(settings.destdir / "foo")
    mock_add_task.assert_called_once_with(
        postprocessing_task, settings.destdir / "foo", "I made a lot of typos", settings.smtp, ANY
    )
    # the very set the listing reads, not merely an equal one: every empty set is equal to
    # every other, so only identity shows the job is registered where it will be looked for
    assert mock_add_task.call_args.args[4] is running_jobs_of(client, settings.destdir)


def test_chunk_upload(client: TestClient, settings: Settings):
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"
    sample_size = os.stat(sample_path).st_size

    for ix, fname in [(0, "chunk.0000"), (42, "chunk.0042"), (9999, "chunk.9999")]:
        with open(sample_path, "rb") as sample:
            response = client.post(
                "/api/chunks",
                data={"recording": "foo", "track": "stream", "index": str(ix)},
                files={"chunk": sample},
            )

        target_path = settings.destdir / "foo" / "stream" / fname

        assert response.status_code == 201
        assert os.path.isfile(target_path)
        assert os.stat(target_path).st_size == sample_size


@pytest.mark.parametrize(
    "recording",
    [
        "GVS_2025-12-21T123456.789Z",
        "\u673a\u5668\u5b66\u4e60\u7b2c\u4e00\u8bb2_2025-12-21T123456.789Z",  # Chinese
        "\u0939\u093f\u0928\u094d\u0926\u0940_\u0935\u094d\u092f\u093e\u0915\u0930\u0923_2025-12-21T123456.789Z",  # Devanagari, which \\w rejected
        "\u00dcbung_3_2025-12-21T123456.789Z",
    ],
)
def test_chunk_upload_stores_a_non_latin_recording_name(
    recording: str, client: TestClient, settings: Settings
):
    # the endpoint has to accept what the frontend derives and then actually create the
    # directory: os.makedirs is where a name that passed validation can still fail
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"

    with open(sample_path, "rb") as sample:
        response = client.post(
            "/api/chunks",
            data={"recording": recording, "track": "stream", "index": "0"},
            files={"chunk": sample},
        )

    assert response.status_code == 201
    assert (settings.destdir / recording / "stream" / "chunk.0000").is_file()


def test_chunk_upload_stores_a_decomposed_name_under_one_directory(
    client: TestClient, settings: Settings
):
    # macOS and several IMEs send NFD, so the same lecture can arrive spelled two ways that
    # are identical on screen. Both have to land in the composed directory, or the chunks of
    # one recording end up split across two and the postprocessing job finds half of them.
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"

    for index, recording in enumerate(["U\u0308bung_2025", "\u00dcbung_2025"]):
        with open(sample_path, "rb") as sample:
            response = client.post(
                "/api/chunks",
                data={"recording": recording, "track": "stream", "index": str(index)},
                files={"chunk": sample},
            )

        assert response.status_code == 201

    composed = settings.destdir / "\u00dcbung_2025" / "stream"

    assert (composed / "chunk.0000").is_file()
    assert (composed / "chunk.0001").is_file()
    assert sorted(p.name for p in settings.destdir.iterdir()) == ["\u00dcbung_2025"]


def test_chunk_upload_truncates_an_overlong_recording_name(client: TestClient, settings: Settings):
    # a client that ignores the frontend's cap must not get a permanent 422 for the length of
    # a lecture, nor an OSError out of os.makedirs. The name is cut to the byte budget instead
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"
    recording = "\u673a" * 200

    with open(sample_path, "rb") as sample:
        response = client.post(
            "/api/chunks",
            data={"recording": recording, "track": "stream", "index": "0"},
            files={"chunk": sample},
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
                "index": "42",
            },
            files={"chunk": sample},
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={
                "recording": "foo",
                "track": "AND 0 == 0; DROP TABLE important_data; --",
                "index": "42",
            },
            files={"chunk": sample},
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={"recording": "foo", "track": "stream", "index": "-1"},
            files={"chunk": sample},
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={"recording": "foo", "track": "stream", "index": "10000"},
            files={"chunk": sample},
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks", data={"recording": "foo", "track": "stream", "index": "42"}
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={
                "recording": "AND 0 == 0; DROP TABLE important_data; --",
                "track": "stream",
                "index": "42",
                "nonsense": "poppycock",
            },
            files={"chunk": sample},
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={
                "recording": "AND 0 == 0; DROP TABLE important_data; --",
                "track": "stream",
                "index": "42",
            },
            files={"chunk": sample, "nonsense": sample},
        )

        assert response.status_code == 422

        response = client.post(
            "/api/chunks",
            data={"recording": "..", "track": "..", "index": "42"},
            files={"chunk": sample},
        )

        assert response.status_code == 422


def test_chunk_upload_with_more_digits(tmp_path: Path):
    # chunk_file_digits is not the default, so this builds its own app rather than taking
    # the shared fixture
    settings = Settings(destdir=tmp_path, chunk_file_digits=5)
    sample_path = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"
    sample_size = os.stat(sample_path).st_size

    cases: list[tuple[int, int, str | None]] = [
        (0, 201, "chunk.00000"),
        (42, 201, "chunk.00042"),
        (12345, 201, "chunk.12345"),
        (99999, 201, "chunk.99999"),
        (100000, 422, None),
    ]

    with TestClient(create_app(settings)) as client:
        for ix, status_code, fname in cases:
            with open(sample_path, "rb") as sample:
                response = client.post(
                    "/api/chunks",
                    data={"recording": "foo", "track": "stream", "index": str(ix)},
                    files={"chunk": sample},
                )

            assert response.status_code == status_code

            if fname is not None:
                target_path = settings.destdir / "foo" / "stream" / fname
                assert os.path.isfile(target_path)
                assert os.stat(target_path).st_size == sample_size


def test_a_chunk_for_a_recording_that_is_rendering_is_refused(
    client: TestClient, settings: Settings
):
    # ffmpeg is reading the track this would be written into, so the chunk would either be
    # left out of the render or change a file halfway through being read
    recording_dir = settings.destdir / "foo"
    write_chunks(recording_dir, [0])
    running_jobs_of(client, settings.destdir).add(recording_dir)
    before = snapshot(settings.destdir)

    response = upload(client, None, index=1)

    assert response.status_code == 409
    assert "foo" in response.json()["detail"]
    assert snapshot(settings.destdir) == before


def test_other_recordings_still_take_chunks_while_one_is_rendering(
    client: TestClient, settings: Settings
):
    # a lecture streamed while an earlier one renders is the ordinary case, not a conflict
    running_jobs_of(client, settings.destdir).add(settings.destdir / "bar")

    assert upload(client, None).status_code == 201
    assert (settings.destdir / "foo" / "stream" / "chunk.0000").is_file()


def test_cors_preflight_jobs_unconfigured(client: TestClient):
    response = client.options(
        "/api/jobs",
        headers={
            "Origin": "http://example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        },
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
            },
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
            },
        )

    assert response.status_code == 400
    assert "Access-Control-Allow-Origin" not in response.headers


# An unauthenticated deployment has one shared destination directory, so there is nobody
# to own a recording and nobody to withhold one from. Both endpoints refuse to serve rather
# than hand every lecture to every caller -- these pin which way each of them refuses.


def test_the_recordings_listing_is_forbidden_without_authentication(
    client: TestClient, settings: Settings
):
    (settings.destdir / "GVS_2025").mkdir(parents=True)
    (settings.destdir / "GVS_2025" / "presentation.webm").write_bytes(b"video")

    response = client.get("/api/recordings")

    assert response.status_code == 403


def test_downloading_is_refused_without_user(client: TestClient, settings: Settings):
    (settings.destdir / "GVS_2025").mkdir(parents=True)
    (settings.destdir / "GVS_2025" / "presentation.webm").write_bytes(b"video")

    response = client.get("/api/recordings/GVS_2025")

    # the path is the purge route's, so this is 405 rather than 404 -- either way, a
    # recording is not served without the user directory in front of it
    assert response.status_code in (404, 405)
    assert b"video" not in response.content


def test_two_apps_share_no_state(tmp_path: Path):
    # each app gets instances of its own, rather than one dict living on a class or module
    first = create_app(Settings(destdir=tmp_path))
    second = create_app(Settings(destdir=tmp_path))

    assert first.state.cached_home_dirs is not second.state.cached_home_dirs
    assert first.state.per_user_running_jobs is not second.state.per_user_running_jobs
    assert first.state.download_totp.factories is not second.state.download_totp.factories


def test_requests_do_not_replace_the_app_state(client: TestClient, app: FastAPI):
    # the listing and /jobs both resolve get_running_jobs, and a job registers in the set it
    # was handed; a request that swapped the dict out would strand it there
    running_jobs = app.state.per_user_running_jobs
    download_totp = app.state.download_totp

    client.post("/api/jobs", json={"recording": "missing"})
    client.get("/api/recordings")

    assert app.state.per_user_running_jobs is running_jobs
    assert app.state.download_totp is download_totp


def test_health_endpoint(client: TestClient):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


@pytest.mark.parametrize("endpoint", ["/api/chunks", "/api/jobs", "/api/health", "/api/recordings"])
def test_every_endpoint_moves_under_the_prefix(prefixed_client: TestClient, endpoint: str):
    assert prefixed_client.get(f"{ROUTE_PREFIX}{endpoint}").status_code != 404


@pytest.mark.parametrize("endpoint", ["/api/chunks", "/api/jobs", "/api/health", "/api/recordings"])
def test_nothing_is_left_behind_at_the_unprefixed_path(prefixed_client: TestClient, endpoint: str):
    assert prefixed_client.get(endpoint).status_code == 404


@pytest.mark.parametrize("prefix", ["foo", "/foo/", "/", " /foo"])
def test_a_malformed_prefix_is_refused_by_the_settings(tmp_path: Path, prefix: str):
    with pytest.raises(ValidationError):
        Settings(destdir=tmp_path, route_prefix=prefix)


@pytest.mark.parametrize("prefix", ["", "/foo", "/foo/bar", "/a-b_c"])
def test_a_well_formed_prefix_is_accepted_and_mounts(tmp_path: Path, prefix: str):
    settings = Settings(destdir=tmp_path, route_prefix=prefix)

    with TestClient(create_app(settings)) as client:
        assert client.get(f"{prefix}/api/health").status_code == 200


# --- the endpoints under authentication ------------------------------------

# Everything above drives a deployment with no provider configured, where every caller
# shares one destination directory. With authentication on, the home directory is a Path
# the dependency hands to the endpoint rather than a segment the endpoint joins onto
# destdir itself -- so these are what show that a caller is confined to their own. How
# that directory gets its name is in core/test_user_home.py.
#
# Token validation and the UserInfo lookup are in core/test_auth.py, and how their outcomes
# become responses in glue/test_auth.py. The first few tests here are the end-to-end check
# that the pieces are wired together: one of each outcome, over a real request.


def test_a_chunk_lands_in_the_callers_home_directory(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    assert upload(auth_client, provider.mint()).status_code == 201

    # the chunk lives under the subject digest, and is reachable through the readable
    # alias as well -- a shell user finding "lecturer-..." has to land on the real data
    assert upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST).is_file()
    assert upload_chunk_path(tmp_path, alias_of("lecturer", DEFAULT_SUBJECT_DIGEST)).is_file()
    assert len(list(tmp_path.rglob("chunk.*"))) == 1


def test_different_subjects_get_different_directories(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    assert upload(auth_client, provider.mint(sub="user-a"), index=0).status_code == 201
    assert upload(auth_client, provider.mint(sub="user-b"), index=1).status_code == 201

    assert upload_chunk_path(tmp_path, digest_of("user-a"), index=0).is_file()
    assert upload_chunk_path(tmp_path, digest_of("user-b"), index=1).is_file()


def test_a_username_from_userinfo_names_the_alias(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="dozentin")

    assert upload(auth_client, provider.mint(preferred_username=None)).status_code == 201

    assert home_entries(tmp_path) == {
        DEFAULT_SUBJECT_DIGEST,
        alias_of("dozentin", DEFAULT_SUBJECT_DIGEST),
    }


def test_uploading_without_a_token_is_rejected(auth_client: TestClient, tmp_path: Path):
    response = upload(auth_client, None)

    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
    assert home_entries(tmp_path) == set()


def test_uploading_with_an_invalid_token_is_rejected(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    assert upload(auth_client, provider.mint(aud="some-other-app")).status_code == 401
    assert home_entries(tmp_path) == set()


def test_an_unreachable_provider_is_reported_as_unavailable(
    auth_client: TestClient, provider: Provider
):
    token = provider.mint()
    provider.jwks_available = False

    assert upload(auth_client, token).status_code == 503


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
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        return_value=Result(output_file=None, reason=ResultReason.SUCCESS),
    )

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
    mock_postprocess = mocker.patch("ise_record.glue.jobs.postprocess_recording", autospec=True)

    assert upload(auth_client, provider.mint(sub="user-a")).status_code == 201

    # a decoy at the destination root, so that this is the home directory being honored
    # rather than the recording merely being absent everywhere: an implementation that
    # resolved the name anywhere but under the caller's own home would find this one
    (tmp_path / "foo" / "stream").mkdir(parents=True)

    response = schedule(auth_client, provider.mint(sub="user-b"))

    assert response.status_code == 400
    mock_postprocess.assert_not_called()


def test_a_chunk_for_the_callers_own_rendering_recording_is_refused(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    running_jobs_of(auth_client, home).add(home / "foo")

    assert upload(auth_client, provider.mint()).status_code == 409
    assert not upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST).exists()


def test_another_subjects_render_does_not_block_a_recording_of_the_same_name(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the running jobs are kept per user, and the recording name alone says nothing about
    # whose it is
    home_a = tmp_path / digest_of("user-a")
    running_jobs_of(auth_client, home_a).add(home_a / "foo")

    assert upload(auth_client, provider.mint(sub="user-b")).status_code == 201
    assert upload_chunk_path(tmp_path, digest_of("user-b")).is_file()


# --- the completed-recording endpoints -------------------------------------

# These are the only endpoints that hand a stored name back to the client and then take it
# again as a path segment, so this is where the recording name has to work as an
# identifier: through percent-encoding, through a client that normalizes differently, and
# without becoming a way into somebody else's home directory.
#
# What the one-time password in the download link is scoped to and how long it lasts is
# the download_totp module's own contract, and lives in core/test_download_totp.py.


def test_listing_recordings_without_a_token_is_rejected(auth_client: TestClient):
    assert list_recordings(auth_client, None).status_code == 401


def test_downloading_without_a_totp_is_rejected(auth_client: TestClient):
    assert download_completed(auth_client, "deadbeef", "foo", None).status_code == 422


def test_the_listing_returns_the_recordings_with_size_and_valid_totp(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    finish_recording(home, "PSU_2026")

    response = list_recordings(auth_client, provider.mint())

    assert response.status_code == 200
    # the names the auth_client has to send back to /api/recordings/{recording}, not the name of
    # the file inside each of them -- which is "presentation.webm" for every recording
    data = response.json()
    download_totp = download_totp_of(auth_client)

    assert isinstance(data, dict)
    assert "user" in data
    assert "completed" in data
    assert isinstance(data["completed"], list)
    assert len(data["completed"]) == 2  # type: ignore

    assert data["completed"][0]["name"] == "GVS_2025"
    assert data["completed"][0]["size"] == 5
    assert download_totp.verify(
        data["completed"][0]["totp"], home / "GVS_2025" / "presentation.webm" # type: ignore
    )

    assert data["completed"][1]["name"] == "PSU_2026"
    assert data["completed"][1]["size"] == 5
    assert download_totp.verify(
        data["completed"][1]["totp"], home / "PSU_2026" / "presentation.webm" # type: ignore
    )


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

    response = list_recordings(auth_client, provider.mint())

    assert [r["name"] for r in response.json()["completed"]] == ["rendered"]


def test_the_listing_only_shows_the_callers_own_recordings(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / digest_of("user-a"), "mine")
    finish_recording(tmp_path / digest_of("user-b"), "theirs")

    assert [
        r["name"]
        for r in list_recordings(auth_client, provider.mint(sub="user-a")).json()["completed"]
    ] == ["mine"]
    assert [
        r["name"]
        for r in list_recordings(auth_client, provider.mint(sub="user-b")).json()["completed"]
    ] == ["theirs"]


# The listing also names the recordings that are still being postprocessed, so the frontend
# can show that a lecture is on its way rather than missing. What it reads is the per-user
# set of running jobs that _postprocessing_task maintains; a TestClient runs background tasks
# to completion before it returns, so the set is seeded by hand to catch a job mid-flight.


def test_the_listing_reports_nothing_rendering_when_no_job_is_running(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")

    data = list_recordings(auth_client, provider.mint()).json()

    # present and empty rather than absent, because the frontend schema requires the field
    assert data["rendering"] == []


def test_a_recording_in_postprocessing_is_listed_as_rendering(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    # a job only ever runs for a recording that is on disk -- /jobs refuses anything else --
    # and the listing classifies what it finds there
    running_jobs_of(auth_client, home).update(
        {abandon_recording(home, "PSU_2026"), abandon_recording(home, "ABC_2026")}
    )

    data = list_recordings(auth_client, provider.mint()).json()

    # a set has no order of its own, and the frontend renders the list as it comes, so the
    # cards would shuffle between polls without the sort
    assert data["rendering"] == [{"name": "ABC_2026"}, {"name": "PSU_2026"}]
    # only the name: there is no file to size and nothing to download yet
    assert [r["name"] for r in data["completed"]] == ["GVS_2025"]


def test_a_recording_being_rerendered_is_only_listed_as_rendering(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the previous render stays on disk until the new one replaces it, so without the
    # filter the recording would show up twice: a download card and a spinner side by side
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    finish_recording(home, "PSU_2026")
    running_jobs_of(auth_client, home).add(home / "PSU_2026")

    data = list_recordings(auth_client, provider.mint()).json()

    assert [r["name"] for r in data["completed"]] == ["GVS_2025"]
    assert data["rendering"] == [{"name": "PSU_2026"}]


def test_a_rerendered_recording_is_offered_for_download_again_once_the_job_is_done(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the job leaving the set is all it takes; a failed rerender leaves the previous render
    # in place, so this holds either way
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    running_jobs_of(auth_client, home).add(home / "GVS_2025")
    token = provider.mint()

    assert list_recordings(auth_client, token).json()["completed"] == []

    running_jobs_of(auth_client, home).discard(home / "GVS_2025")

    data = list_recordings(auth_client, token).json()

    assert [r["name"] for r in data["completed"]] == ["GVS_2025"]
    assert data["rendering"] == []


def test_the_listing_only_shows_the_callers_own_rendering_jobs(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home_a = tmp_path / digest_of("user-a")
    running_jobs_of(auth_client, home_a).add(abandon_recording(home_a, "mine"))

    assert list_recordings(auth_client, provider.mint(sub="user-a")).json()["rendering"] == [
        {"name": "mine"}
    ]
    assert list_recordings(auth_client, provider.mint(sub="user-b")).json()["rendering"] == []


def test_a_scheduled_job_is_rendering_where_the_listing_looks_for_it(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the scheduling and the listing endpoint have to agree on which set a job goes into;
    # a job filed anywhere else would render without ever showing up in the listing
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    seen_while_running: list[set[Path]] = []

    async def fake_postprocess(_recording_path: Path) -> Result:
        seen_while_running.append(set(running_jobs_of(auth_client, home)))
        return Result(output_file=None, reason=ResultReason.SUCCESS)

    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, side_effect=fake_postprocess
    )

    token = provider.mint()
    assert upload(auth_client, token).status_code == 201
    assert schedule(auth_client, token).status_code == 202

    assert seen_while_running == [{home / "foo"}]
    # and gone again once it finished, or the card would spin forever
    assert list_recordings(auth_client, token).json()["rendering"] == []


# The listing's third list: recordings whose postprocessing never produced anything. Which
# recordings count is get_unprocessed_recordings' business, in glue/test_recording_lists.py;
# these pin what the endpoint makes of it.


def test_the_listing_reports_unprocessed_recordings_by_name(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "DONE_2025")
    abandon_recording(home, "GVS_2025")

    data = list_recordings(auth_client, provider.mint()).json()

    # only the name: there is nothing to download, and the Rerender button needs no more
    assert data["unprocessed"] == [{"name": "GVS_2025"}]
    assert [r["name"] for r in data["completed"]] == ["DONE_2025"]
    assert data["rendering"] == []


def test_the_listing_reports_no_unprocessed_recordings_when_there_are_none(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "DONE_2025")

    # present and empty rather than absent, because the frontend schema requires the field
    assert list_recordings(auth_client, provider.mint()).json()["unprocessed"] == []


def test_the_listing_only_shows_the_callers_own_unprocessed_recordings(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    abandon_recording(tmp_path / digest_of("user-a"), "mine")
    abandon_recording(tmp_path / digest_of("user-b"), "theirs")

    assert list_recordings(auth_client, provider.mint(sub="user-a")).json()["unprocessed"] == [
        {"name": "mine"}
    ]
    assert list_recordings(auth_client, provider.mint(sub="user-b")).json()["unprocessed"] == [
        {"name": "theirs"}
    ]


def test_a_rerendered_recording_moves_from_unprocessed_to_rendering(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # what the lecturer sees after pressing Rerender on a failed card: the card turns into
    # a spinner rather than showing up twice
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    recording_dir = abandon_recording(home, "GVS_2025")
    token = provider.mint()

    assert list_recordings(auth_client, token).json()["unprocessed"] == [{"name": "GVS_2025"}]

    running_jobs_of(auth_client, home).add(recording_dir)
    data = list_recordings(auth_client, token).json()

    assert data["unprocessed"] == []
    assert data["rendering"] == [{"name": "GVS_2025"}]


def test_a_completed_recording_can_be_downloaded(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025", b"the rendered lecture")

    server_list = list_recordings(auth_client, provider.mint()).json()

    response = download_completed(
        auth_client, server_list["user"], "GVS_2025", server_list["completed"][0]["totp"]
    )

    assert response.status_code == 200
    assert response.content == b"the rendered lecture"
    assert response.headers["content-type"] == "video/webm"
    # the file on disk is called presentation.webm for everyone, so the recording name is
    # what the browser has to save it under
    assert response.headers["content-disposition"] == 'attachment; filename="GVS_2025.webm"'


@pytest.mark.parametrize(
    "recording",
    [
        "Übung_3_2025",  # Latin with a diacritic
        "机器学习_2025",  # Chinese
        "हिन्दी_2025",  # Devanagari, combining marks
    ],
)
def test_a_recording_name_survives_the_round_trip_through_the_url(
    recording: str, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the name is percent-encoded on the way out and decoded on the way back in, and
    # SafeRecording runs over it a second time -- a stored name has to be a fixed point of
    # that validator or the listing offers links that 404
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, recording)
    token = provider.mint()

    server_list = list_recordings(auth_client, token).json()

    assert server_list["completed"][0]["name"] == recording

    response = download_completed(
        auth_client, server_list["user"], recording, server_list["completed"][0]["totp"]
    )

    assert response.status_code == 200
    assert response.content == b"video"
    # RFC 5987, because the name does not fit in a quoted ASCII filename
    assert response.headers["content-disposition"] == (
        f"attachment; filename*=utf-8''{quote(recording)}.webm"
    )


def test_a_decomposed_name_downloads_the_composed_recording(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the counterpart of the upload test: macOS sends NFD, the recording was stored under
    # NFC, and SafeRecording's BeforeValidator is what makes the two the same request
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "Übung_2025")

    server_list = list_recordings(auth_client, provider.mint()).json()

    response = download_completed(
        auth_client, server_list["user"], "U\u0308bung_2025", server_list["completed"][0]["totp"]
    )

    assert response.status_code == 200
    assert response.content == b"video"


@pytest.mark.parametrize("user_digest", ["..", "not-hex", "AAAA", ""])
def test_a_user_directory_that_is_not_a_digest_is_refused(
    user_digest: str, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")

    server_list = list_recordings(auth_client, provider.mint()).json()

    # the segment is joined onto destdir, so anything but a lowercase hex digest has to be
    # refused before it reaches the filesystem
    response = download_completed(
        auth_client, user_digest, "GVS_2025", server_list["completed"][0]["totp"]
    )

    assert response.status_code in (404, 422)
    assert b"video" not in response.content


def test_downloading_is_forbidden_without_authentication(client: TestClient, settings: Settings):
    # the counterpart of the listing test above, on the route that actually serves bytes:
    # an unauthenticated deployment has one shared destdir and nobody to own a recording
    (settings.destdir / "GVS_2025").mkdir(parents=True)
    (settings.destdir / "GVS_2025" / "presentation.webm").write_bytes(b"video")

    response = client.get("/api/recordings/deadbeef/GVS_2025", params={"totp": "0000000000"})

    assert response.status_code == 403
    assert b"video" not in response.content


# --- download OTPs through the endpoints -----------------------------------

# The properties from core/test_download_totp.py, restated over a real request, because
# what the download route actually verifies against is a path it assembles from two
# segments the caller supplies.


def test_a_totp_is_scoped_to_the_one_recording_it_was_issued_for(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    finish_recording(home, "PSU_2026", b"the other lecture")

    server_list = list_recordings(auth_client, provider.mint()).json()
    by_name = {rec["name"]: rec["totp"] for rec in server_list["completed"]}

    response = download_completed(auth_client, server_list["user"], "PSU_2026", by_name["GVS_2025"])

    assert response.status_code == 401
    assert b"the other lecture" not in response.content


def test_a_totp_does_not_open_another_subjects_recording(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / digest_of("user-a"), "shared_name")
    finish_recording(tmp_path / digest_of("user-b"), "shared_name", b"not yours")

    server_list = list_recordings(auth_client, provider.mint(sub="user-a")).json()

    # the user directory is a path segment the caller supplies, so the OTP has to be tied
    # to the full path rather than to the recording name both of them happen to use
    response = download_completed(
        auth_client, digest_of("user-b"), "shared_name", server_list["completed"][0]["totp"]
    )

    assert response.status_code == 401
    assert b"not yours" not in response.content


def test_a_recording_that_was_never_listed_cannot_be_downloaded(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "listed")
    finish_recording(home, "never_listed", b"secret lecture")

    # only one of them is ever listed, so the other never gets a generator
    server_list = list_recordings(auth_client, provider.mint()).json()

    response = download_completed(
        auth_client, server_list["user"], "never_listed", server_list["completed"][0]["totp"]
    )

    assert response.status_code == 401
    assert b"secret lecture" not in response.content


def test_a_totp_from_an_earlier_interval_is_refused_by_the_endpoint(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")

    server_list = list_recordings(auth_client, provider.mint()).json()

    key = str((home / "GVS_2025" / "presentation.webm").absolute())
    generator = download_totp_of(auth_client).factories[key]
    three_intervals = datetime.timedelta(seconds=3 * generator.interval)
    three_intervals_ago = datetime.datetime.now(datetime.UTC) - three_intervals
    stale = generator.at(three_intervals_ago)

    response = download_completed(auth_client, server_list["user"], "GVS_2025", stale)

    assert response.status_code == 401
    assert b"video" not in response.content


# --- purging a recording ---------------------------------------------------

# The one endpoint that destroys data, and irreversibly. Every refusal below checks the disk
# rather than only the status code: a 4xx that had already deleted something would pass a
# status check just fine. Which recordings count as purgeable is get_purgeable_recordings'
# business, in glue/test_recording_lists.py; these pin what the endpoint does with the answer.


def snapshot(root: Path) -> dict[str, bytes]:
    """Every file under root with its content, following no symlinks."""
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file() and not p.is_symlink()
    }


def rendered_recording(home: Path, name: str) -> Path:
    """A recording as it looks after a successful render: chunks, output, leftovers."""
    recording_dir = home / name
    write_chunks(recording_dir, [30 * 60, 29 * 60])
    write_chunks(recording_dir, [30 * 60], track="overlay")
    (recording_dir / "presentation.webm").write_bytes(b"the rendered lecture")
    return recording_dir


def test_a_purge_deletes_the_whole_recording(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    recording_dir = rendered_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")

    response = purge(auth_client, provider.mint(), "GVS_2025")

    assert response.status_code == 200
    assert response.json()["recording"] == "GVS_2025"
    assert not recording_dir.exists()


def test_a_purge_leaves_everything_else_alone(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "GVS_2025")
    rendered_recording(home, "PSU_2026")
    # the same name under another user, and a decoy at the destination root: a purge that
    # resolved the name anywhere but under the caller's own home would find one of these
    rendered_recording(tmp_path / digest_of("someone-else"), "GVS_2025")
    rendered_recording(tmp_path, "GVS_2025")

    before = snapshot(tmp_path)
    assert purge(auth_client, provider.mint(), "GVS_2025").status_code == 200

    expected = {
        k: v for k, v in before.items() if not k.startswith(f"{DEFAULT_SUBJECT_DIGEST}/GVS_2025/")
    }
    assert snapshot(tmp_path) == expected


def test_a_purged_recording_leaves_the_listing(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    rendered_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")
    token = provider.mint()

    assert [r["name"] for r in list_recordings(auth_client, token).json()["completed"]] == [
        "GVS_2025"
    ]
    assert purge(auth_client, token, "GVS_2025").status_code == 200

    data = list_recordings(auth_client, token).json()
    assert data["completed"] == [] and data["rendering"] == [] and data["unprocessed"] == []


def test_a_purged_recording_takes_its_download_otp_with_it(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "GVS_2025")
    token = provider.mint()
    server_list = list_recordings(auth_client, token).json()

    assert purge(auth_client, token, "GVS_2025").status_code == 200

    # a lecture recorded again under the same name must not be downloadable with a link
    # that was handed out for the one that was purged
    rendered_recording(home, "GVS_2025")
    response = download_completed(
        auth_client, server_list["user"], "GVS_2025", server_list["completed"][0]["totp"]
    )

    assert response.status_code == 401
    assert (
        str((home / "GVS_2025" / "presentation.webm").absolute())
        not in download_totp_of(auth_client).factories
    )


def test_an_unprocessed_recording_can_be_purged(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the other card that offers Purge: a render that failed, with no output to show for it
    recording_dir = abandon_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")
    (recording_dir / "presentation.part.webm").write_bytes(b"half")

    assert purge(auth_client, provider.mint(), "GVS_2025").status_code == 200
    assert not recording_dir.exists()


def test_a_decomposed_name_purges_the_composed_recording(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the same normalization as on upload and download, so the purge hits the recording the
    # lecturer saw rather than 404ing on a macOS client
    recording_dir = rendered_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "\u00dcbung_2025")

    assert purge(auth_client, provider.mint(), "U\u0308bung_2025").status_code == 200
    assert not recording_dir.exists()


def test_a_purge_is_logged_with_the_user_who_asked(
    auth_client: TestClient, provider: Provider, tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    # nothing else is left afterwards to say where the recording went
    rendered_recording(tmp_path / digest_of("user-a"), "GVS_2025")

    with caplog.at_level("INFO", logger="ise_record"):
        assert purge(auth_client, provider.mint(sub="user-a"), "GVS_2025").status_code == 200

    assert any("user-a" in r.getMessage() and "GVS_2025" in r.getMessage() for r in caplog.records)


# refusals ------------------------------------------------------------------


def test_purging_without_a_token_is_rejected(auth_client: TestClient, tmp_path: Path):
    rendered_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")
    before = snapshot(tmp_path)

    assert purge(auth_client, None, "GVS_2025").status_code == 401
    assert snapshot(tmp_path) == before


def test_purging_is_forbidden_without_authentication(client: TestClient, settings: Settings):
    # an unauthenticated deployment has one shared destination directory and nobody to own
    # a recording, so nobody may delete one either
    rendered_recording(settings.destdir, "GVS_2025")
    before = snapshot(settings.destdir)

    assert purge(client, None, "GVS_2025").status_code == 403
    assert snapshot(settings.destdir) == before


def test_purging_a_recording_that_does_not_exist_is_a_404(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    rendered_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")
    before = snapshot(tmp_path)

    assert purge(auth_client, provider.mint(), "PSU_2026").status_code == 404
    assert snapshot(tmp_path) == before


def test_another_users_recording_cannot_be_purged(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    rendered_recording(tmp_path / digest_of("user-a"), "GVS_2025")
    before = snapshot(tmp_path)

    # user-b has no recording of that name, so from where they stand it does not exist
    assert purge(auth_client, provider.mint(sub="user-b"), "GVS_2025").status_code == 404
    assert snapshot(tmp_path) == before


@pytest.mark.parametrize(
    "recording",
    [
        "..",
        "%2e%2e",
        "..%2fvictim",
        "%2e%2e%2fvictim",
        ".hidden",
        "%2e%2e%2f%2e%2e%2fvictim",
        "foo%00bar",
    ],
)
def test_a_recording_name_cannot_reach_outside_the_home_directory(
    recording: str, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "GVS_2025")
    rendered_recording(tmp_path, "victim")
    (home / ".hidden").mkdir()
    before = snapshot(tmp_path)

    # sent as-is rather than through purge(), which would quote the tricks away
    response = auth_client.delete(
        f"/api/recordings/{recording}", headers={"Authorization": f"Bearer {provider.mint()}"}
    )

    assert response.status_code in (404, 405, 422)
    assert snapshot(tmp_path) == before
    assert home.is_dir()


def test_a_symlink_in_the_home_directory_is_not_followed(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # nothing in the app creates one, but a purge must not become a way to delete whatever
    # a link happens to point at
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "GVS_2025")
    rendered_recording(tmp_path, "victim")
    (home / "link").symlink_to(tmp_path / "victim", target_is_directory=True)
    before = snapshot(tmp_path)

    assert purge(auth_client, provider.mint(), "link").status_code == 404
    assert snapshot(tmp_path) == before
    assert (home / "link").is_symlink()


def test_a_recording_that_is_rendering_cannot_be_purged(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # a rerender: the old output is still there, so this is a finished recording by every
    # other measure. Deleting it would pull the chunks out from under ffmpeg.
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    recording_dir = rendered_recording(home, "GVS_2025")
    running_jobs_of(auth_client, home).add(recording_dir)
    before = snapshot(tmp_path)

    assert purge(auth_client, provider.mint(), "GVS_2025").status_code == 409
    assert snapshot(tmp_path) == before


def test_a_recording_that_is_still_being_streamed_cannot_be_purged(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the next chunk would recreate the directory and bring back half a recording
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    write_chunks(home / "LIVE_2026", [30 * 60, 5])
    before = snapshot(tmp_path)

    assert purge(auth_client, provider.mint(), "LIVE_2026").status_code == 409
    assert snapshot(tmp_path) == before


def test_a_failing_filesystem_is_reported_without_details(
    mocker: MockerFixture,
    auth_client: TestClient,
    provider: Provider,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
):
    # the details go to the log for the admin; the response only says that it failed
    rendered_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")
    mocker.patch(
        "shutil.rmtree", side_effect=PermissionError(13, "Permission denied", "/secret/path")
    )

    with caplog.at_level("ERROR", logger="ise_record"):
        response = purge(auth_client, provider.mint(), "GVS_2025")

    assert response.status_code == 500
    assert "/secret/path" not in response.text
    assert any(r.exc_info is not None and r.exc_info[0] is PermissionError for r in caplog.records)


def test_cors_preflight_allows_purging(tmp_path: Path):
    # without DELETE here the browser refuses the request before it is sent, whenever the
    # frontend is served from another origin than the backend
    cors_settings = Settings(destdir=tmp_path, cors_origins=("http://allowed.example.com",))

    with TestClient(create_app(cors_settings)) as cors_client:
        response = cors_client.options(
            "/api/recordings/GVS_2025",
            headers={
                "Origin": "http://allowed.example.com",
                "Access-Control-Request-Method": "DELETE",
                "Access-Control-Request-Headers": "Authorization",
            },
        )

    assert response.status_code == 200
    assert "DELETE" in response.headers["Access-Control-Allow-Methods"]
    assert "authorization" in response.headers["Access-Control-Allow-Headers"].lower()
