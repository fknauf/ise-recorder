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

from collections.abc import AsyncGenerator, Callable, Iterator
import datetime
import os
from pathlib import Path
import shutil
import threading
from unittest.mock import ANY
from urllib.parse import quote

import anyio
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import ResponseValidationError
from fastapi.testclient import TestClient
from httpx2 import Response
from pydantic import ValidationError
import pytest
from pytest_mock import MockerFixture
from starlette.requests import ClientDisconnect
from starlette.types import Message, Scope

from ise_record.core.postprocess import Result, ResultReason
from ise_record.core.recordings import RecordingActivity
from ise_record.glue.jobs import postprocessing_task
from ise_record.glue.models import RenderRequest
from ise_record.server import (
    _get_request_exit_stacks,  # pyright: ignore[reportPrivateUsage]
    create_app,
    HandoverExitStacks,
)
from ise_record.settings import AuthBackend, Settings

from .harness import (
    abandon_recording,
    activity_of,
    alias_of,
    app_of,
    chunk_url,
    DEFAULT_SUBJECT,
    DEFAULT_SUBJECT_DIGEST,
    digest_of,
    download_completed,
    download_parts,
    enclave_of,
    entries,
    finish_recording,
    follow_download,
    home_entries,
    job_in_flight,
    list_recordings,
    names,
    otp_generator_of,
    Provider,
    purge,
    purge_in_flight,
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
    """A deployment without authentication, with a destination directory of this test's own."""
    return Settings(destdir=anyio.Path(tmp_path), auth=AuthBackend.DISABLED)


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
    return Settings(
        destdir=anyio.Path(tmp_path), auth=AuthBackend.DISABLED, route_prefix=ROUTE_PREFIX
    )


@pytest.fixture
def prefixed_client(prefixed_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(prefixed_settings)) as test_client:
        yield test_client


def render_url(recording: str) -> str:
    return f"/api/recordings/{quote(recording, safe='')}/render"


def test_schedule_postprocessing(mocker: MockerFixture, client: TestClient, settings: Settings):
    abandon_recording(settings.destdir, "foo")
    claimed_when_queued: list[RecordingActivity] = []

    def note_claim_when_queued(*_args: object) -> None:
        claimed_when_queued.append(activity_of(client, settings.destdir, "foo"))

    mock_add_task = mocker.patch(
        "fastapi.BackgroundTasks.add_task", side_effect=note_claim_when_queued
    )

    response = client.post(render_url("foo"), json={"recipient": "foo@bar.de"})

    assert response.status_code == 202
    mock_add_task.assert_called_once_with(
        postprocessing_task,
        settings.destdir / "foo",
        RenderRequest(recipient="foo@bar.de"),
        settings.smtp,
        ANY,
        ANY,
    )
    # claimed by the time the task is queued, so no request that comes in before it starts
    # can take the recording for a purge or a second render
    assert claimed_when_queued == [RecordingActivity.RENDERING]
    # the app's one semaphore, which is what makes the limit apply across all jobs and users
    assert mock_add_task.call_args.args[4] is app_of(client).state.jobs_semaphore


def test_a_render_answers_with_the_recording_now_rendering(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    # the frontend puts it into its copy of the listing straight away, rather than wait for the
    # next poll to turn the card into a spinner
    abandon_recording(settings.destdir, "foo")
    mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(render_url("foo"), json={})

    assert response.json() == {"state": "rendering", "name": "foo"}


def test_a_render_answers_with_the_name_the_recording_is_stored_under(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    # a decomposed name is the composed recording, and the answer has to name it the way the
    # listing does, or the frontend would not find the card to update
    abandon_recording(settings.destdir, "\u00dcbung_2025")
    mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(render_url("U\u0308bung_2025"), json={})

    assert response.status_code == 202
    assert response.json() == {"state": "rendering", "name": "\u00dcbung_2025"}


def test_schedule_postprocessing_recipient_omitted(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    abandon_recording(settings.destdir, "foo")
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(render_url("foo"), json={})

    assert response.status_code == 202
    mock_add_task.assert_called_once_with(
        postprocessing_task,
        settings.destdir / "foo",
        RenderRequest(recipient=None),
        settings.smtp,
        ANY,
        ANY,
    )
    # the app's one semaphore, which is what makes the limit apply across all jobs and users
    assert mock_add_task.call_args.args[4] is app_of(client).state.jobs_semaphore


def test_the_recipient_is_not_taken_from_the_url(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    # an address in the query string would end up in every access log on the way
    abandon_recording(settings.destdir, "foo")
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    client.post(render_url("foo"), params={"recipient": "foo@bar.de"}, json={})

    assert mock_add_task.call_args.args[2] == RenderRequest(recipient=None)


def test_schedule_postprocessing_error(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(render_url("foo"), json={"recipient": "foo@bar.de"})

    # the recording is a resource of the caller's that is not there, not a malformed request
    assert response.status_code == 404
    mock_add_task.assert_not_called()
    # and the refusal does not keep the name claimed
    assert activity_of(client, settings.destdir, "foo") == RecordingActivity.NONE


@pytest.mark.parametrize("track", ["overlay", None])
def test_a_job_for_a_recording_that_cannot_be_rendered_is_refused(
    mocker: MockerFixture, client: TestClient, settings: Settings, track: str | None
):
    # no main stream, or nothing in it: postprocessing would only give up with
    # MAIN_STREAM_MISSING, so the request says so rather than accept a job that does nothing
    if track is None:
        (Path(settings.destdir) / "foo" / "stream").mkdir(parents=True)
    else:
        write_chunks(settings.destdir / "foo", [30 * 60], track=track)
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(render_url("foo"), json={})

    assert response.status_code == 422
    mock_add_task.assert_not_called()
    assert activity_of(client, settings.destdir, "foo") == RecordingActivity.NONE


def test_schedule_postprocessing_input_validation(mocker: MockerFixture, client: TestClient):
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    for recording in ["AND 0 == 0; DROP TABLE important_data; --", ".hidden"]:
        response = client.post(render_url(recording), json={"recipient": "foo@bar.de"})

        assert response.status_code == 422

    # and dot segments, sent encoded as a browser would: the URL resolution that removes them
    # from a literal path never sees them
    assert client.post("/api/recordings/%2E%2E/render", json={}).status_code == 422
    mock_add_task.assert_not_called()


def test_a_render_request_needs_a_body(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    abandon_recording(settings.destdir, "foo")
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    assert client.post(render_url("foo")).status_code == 422
    mock_add_task.assert_not_called()


def test_schedule_postprocessing_broken_recipient_still_starts_post(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    abandon_recording(settings.destdir, "foo")
    mock_add_task = mocker.patch("fastapi.BackgroundTasks.add_task")

    response = client.post(render_url("foo"), json={"recipient": "I made a lot of typos"})

    assert response.status_code == 202
    mock_add_task.assert_called_once_with(
        postprocessing_task,
        settings.destdir / "foo",
        RenderRequest(recipient="I made a lot of typos"),
        settings.smtp,
        ANY,
        ANY,
    )
    # the app's one semaphore, which is what makes the limit apply across all jobs and users
    assert mock_add_task.call_args.args[4] is app_of(client).state.jobs_semaphore


SAMPLE = Path(os.path.dirname(__file__)) / "assets" / "sample.webm"


def test_chunk_upload(client: TestClient, settings: Settings):
    sample = SAMPLE.read_bytes()

    for ix, fname in [(0, "chunk.0000"), (42, "chunk.0042"), (9999, "chunk.9999")]:
        response = upload(client, None, index=ix, content=sample)

        target_path = Path(settings.destdir) / "foo" / "stream" / fname

        # nothing to say back: the client knows what it sent, and where
        assert response.status_code == 204
        assert response.content == b""
        assert target_path.read_bytes() == sample


def test_a_chunk_uploaded_again_replaces_the_first_copy(client: TestClient, settings: Settings):
    # a retry after an answer that never arrived sends the same chunk again; storing it under
    # the same name is what makes that safe
    assert upload(client, None, index=3, content=b"first try").status_code == 204
    assert upload(client, None, index=3, content=b"second try").status_code == 204

    track = Path(settings.destdir) / "foo" / "stream"
    assert sorted(p.name for p in track.iterdir()) == ["chunk.0003"]
    assert (track / "chunk.0003").read_bytes() == b"second try"


def test_a_chunk_larger_than_one_read_arrives_whole(client: TestClient, settings: Settings):
    # the body is written piece by piece as the server hands it over
    big = bytes(range(256)) * 4096

    assert upload(client, None, content=big).status_code == 204
    assert (Path(settings.destdir) / "foo" / "stream" / "chunk.0000").read_bytes() == big


def chunk_upload_scope(recording: str, index: int) -> Scope:
    """
    The ASGI scope of a chunk upload, for tests that talk ASGI to the app directly because they
    need control over how the body arrives, which a TestClient hands over in one go.
    """
    path = chunk_url(recording, "stream", index)
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "PUT",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": [(b"host", b"testserver")],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
        "state": {},
    }


@pytest.mark.asyncio
async def test_a_chunk_that_arrives_in_pieces_is_stored_whole(app: FastAPI, settings: Settings):
    # A real server hands the body over piece by piece as it comes off the socket, and the
    # endpoint has to write every piece. This delivers it in three.
    pieces = [b"first ", b"second ", b"third"]
    incoming: list[Message] = [
        {"type": "http.request", "body": piece, "more_body": True} for piece in pieces
    ]
    incoming.append({"type": "http.request", "body": b"", "more_body": False})
    outgoing: list[Message] = []

    async def receive() -> Message:
        return incoming.pop(0) if incoming else {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        outgoing.append(message)

    await app(chunk_upload_scope("foo", 0), receive, send)

    assert outgoing[0]["status"] == 204
    chunk = Path(settings.destdir) / "foo" / "stream" / "chunk.0000"
    assert chunk.read_bytes() == b"first second third"


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
    # the endpoint has to accept what the frontend derives, percent-encoded in the path, and
    # then actually create the directory: mkdir is where a name that passed validation can
    # still fail
    response = upload(client, None, recording=recording, content=SAMPLE.read_bytes())

    assert response.status_code == 204
    assert (Path(settings.destdir) / recording / "stream" / "chunk.0000").is_file()


def test_chunk_upload_stores_a_decomposed_name_under_one_directory(
    client: TestClient, settings: Settings
):
    # macOS and several IMEs send NFD, so the same lecture can arrive spelled two ways that
    # are identical on screen. Both have to land in the composed directory, or the chunks of
    # one recording end up split across two and the postprocessing job finds half of them.
    for index, recording in enumerate(["U\u0308bung_2025", "\u00dcbung_2025"]):
        response = upload(client, None, index=index, recording=recording)

        assert response.status_code == 204

    composed = Path(settings.destdir) / "\u00dcbung_2025" / "stream"

    assert (composed / "chunk.0000").is_file()
    assert (composed / "chunk.0001").is_file()
    assert sorted(p.name for p in Path(settings.destdir).iterdir()) == ["\u00dcbung_2025"]


def test_chunk_upload_truncates_an_overlong_recording_name(client: TestClient, settings: Settings):
    # a client that ignores the frontend's cap must not get a permanent 422 for the length of
    # a lecture, nor an OSError out of mkdir. The name is cut to the byte budget instead
    recording = "\u673a" * 200

    response = upload(client, None, recording=recording)

    assert response.status_code == 204

    stored = list(Path(settings.destdir).iterdir())

    assert len(stored) == 1
    assert len(stored[0].name.encode("utf-8")) <= NAME_MAX_BYTES
    assert recording.startswith(stored[0].name)
    assert (stored[0] / "stream" / "chunk.0000").is_file()


@pytest.mark.parametrize(
    "url",
    [
        chunk_url("AND 0 == 0; DROP TABLE important_data; --", "stream", 42),
        chunk_url("foo", "AND 0 == 0; DROP TABLE important_data; --", 42),
        chunk_url("foo", "stream", -1),
        chunk_url("foo", "stream", 10000),
        chunk_url("foo", "stream", "forty-two"),
        # dot segments, sent encoded as a browser would: the URL resolution that removes them
        # from a literal path never sees them
        "/api/recordings/%2E%2E/tracks/stream/chunks/42",
        "/api/recordings/foo/tracks/%2E%2E/chunks/42",
    ],
)
def test_chunk_upload_input_validation(client: TestClient, settings: Settings, url: str):
    response = client.put(url, content=SAMPLE.read_bytes())

    assert response.status_code == 422
    assert not list(Path(settings.destdir).iterdir())


def test_chunk_upload_with_more_digits(tmp_path: Path):
    # chunk_file_digits is not the default, so this builds its own app rather than taking
    # the shared fixture
    settings = Settings(
        destdir=anyio.Path(tmp_path), auth=AuthBackend.DISABLED, chunk_file_digits=5
    )
    sample = SAMPLE.read_bytes()

    cases: list[tuple[int, int, str | None]] = [
        (0, 204, "chunk.00000"),
        (42, 204, "chunk.00042"),
        (12345, 204, "chunk.12345"),
        (99999, 204, "chunk.99999"),
        (100000, 422, None),
    ]

    with TestClient(create_app(settings)) as client:
        for ix, status_code, fname in cases:
            response = upload(client, None, index=ix, content=sample)

            assert response.status_code == status_code

            if fname is not None:
                assert (tmp_path / "foo" / "stream" / fname).read_bytes() == sample


def test_a_chunk_for_a_recording_that_is_rendering_is_kept(client: TestClient, settings: Settings):
    # a late chunk, or a retried one, may be the only copy there is; refusing it would lose it,
    # while a render that missed it can be repeated
    write_chunks(settings.destdir / "foo", [0])

    with job_in_flight(client, settings.destdir, "foo"):
        response = upload(client, None, index=1)

        assert response.status_code == 204
        assert activity_of(client, settings.destdir, "foo") == RecordingActivity.RENDERING

    assert (Path(settings.destdir) / "foo" / "stream" / "chunk.0001").read_bytes() == b"payload"


def test_a_chunk_appears_under_its_name_only_once_it_is_complete(
    client: TestClient, settings: Settings
):
    # a render running alongside reads every chunk.* it finds, so a chunk being written is
    # kept under another name until the last byte is in
    assert upload(client, None, index=3).status_code == 204

    track = Path(settings.destdir) / "foo" / "stream"
    assert sorted(p.name for p in track.iterdir()) == ["chunk.0003"]


@pytest.mark.asyncio
async def test_a_chunk_that_breaks_off_leaves_nothing_behind(
    app: FastAPI, client: TestClient, settings: Settings
):
    # the client went away halfway through. What arrived must not turn up under a name a render
    # would take for a complete chunk, and is not worth keeping either: the frontend's retry
    # sends the whole chunk again. Left behind, it would pile up with every broken upload.
    incoming: list[Message] = [
        {"type": "http.request", "body": b"first half", "more_body": True},
        {"type": "http.disconnect"},
    ]

    async def receive() -> Message:
        return incoming.pop(0)

    async def send(_message: Message) -> None:
        return None

    with pytest.raises(ClientDisconnect):
        await app(chunk_upload_scope("foo", 3), receive, send)

    assert not list((Path(settings.destdir) / "foo" / "stream").iterdir())
    # and the broken upload does not keep the recording claimed
    assert activity_of(client, settings.destdir, "foo") == RecordingActivity.NONE


def test_other_recordings_still_take_chunks_while_one_is_rendering(
    client: TestClient, settings: Settings
):
    # a lecture streamed while an earlier one renders is the ordinary case, not a conflict
    abandon_recording(settings.destdir, "bar")

    with job_in_flight(client, settings.destdir, "bar"):
        assert upload(client, None).status_code == 204
    assert (Path(settings.destdir) / "foo" / "stream" / "chunk.0000").is_file()


def test_cors_preflight_jobs_unconfigured(client: TestClient):
    response = client.options(
        render_url("foo"),
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
    cors_settings = Settings(
        destdir=anyio.Path(tmp_path),
        auth=AuthBackend.DISABLED,
        cors_origins=("http://allowed.example.com",),
    )

    with TestClient(create_app(cors_settings)) as cors_client:
        response = cors_client.options(
            render_url("foo"),
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
    cors_settings = Settings(
        destdir=anyio.Path(tmp_path),
        auth=AuthBackend.DISABLED,
        cors_origins=("http://allowed.example.com",),
    )

    with TestClient(create_app(cors_settings)) as cors_client:
        response = cors_client.options(
            render_url("foo"),
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
    finish_recording(settings.destdir, "GVS_2025")

    response = client.get("/api/recordings")

    assert response.status_code == 403


def test_downloading_is_refused_without_user(client: TestClient, settings: Settings):
    finish_recording(settings.destdir, "GVS_2025")

    for path in ["/api/recordings/GVS_2025", "/api/downloads/GVS_2025"]:
        response = client.get(path)

        # either path is some other route's or none at all -- either way, a recording is not
        # served without the user digest in front of it
        assert response.status_code in (404, 405)
        assert b"video" not in response.content


def test_two_apps_share_no_state(tmp_path: Path):
    # each app gets instances of its own, rather than one dict living on a class or module
    first = create_app(Settings(destdir=anyio.Path(tmp_path), auth=AuthBackend.DISABLED))
    second = create_app(Settings(destdir=anyio.Path(tmp_path), auth=AuthBackend.DISABLED))

    assert first.state.enclaves is not second.state.enclaves
    # one limit per app: a semaphore shared between apps would let one app's jobs hold up
    # another's, and bind it to whichever event loop got to it first
    assert first.state.jobs_semaphore is not second.state.jobs_semaphore


@pytest.mark.asyncio
async def test_the_app_allows_as_many_jobs_at_once_as_configured(tmp_path: Path):
    semaphore = create_app(
        Settings(destdir=anyio.Path(tmp_path), auth=AuthBackend.DISABLED, max_parallel_jobs=3)
    ).state.jobs_semaphore

    for _ in range(3):
        await semaphore.acquire()

    # three slots taken, so a fourth job would have to wait
    assert semaphore.locked()


def test_requests_do_not_replace_the_app_state(client: TestClient, app: FastAPI):
    # the listing and /jobs both resolve get_enclave, and a job registers in the set of the
    # enclave it was handed; a request that swapped either out would strand it there
    enclaves = app.state.enclaves
    semaphore = app.state.jobs_semaphore

    client.post(render_url("missing"), json={})
    enclave = enclaves[None]
    client.post(render_url("missing"), json={})
    client.get("/api/recordings")

    assert app.state.enclaves is enclaves
    assert app.state.enclaves[None] is enclave
    assert app.state.jobs_semaphore is semaphore


def test_health_endpoint(client: TestClient):
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


ENDPOINTS = [
    ("PUT", chunk_url("foo", "stream", 0)),
    ("POST", "/api/recordings/foo/render"),
    ("GET", "/api/health"),
    ("GET", "/api/recordings"),
    ("DELETE", "/api/recordings/foo"),
    ("GET", f"/api/downloads/{digest_of('abc')}/foo"),
]


@pytest.mark.parametrize("method, endpoint", ENDPOINTS)
def test_every_endpoint_moves_under_the_prefix(
    prefixed_client: TestClient, method: str, endpoint: str
):
    assert prefixed_client.request(method, f"{ROUTE_PREFIX}{endpoint}").status_code != 404


@pytest.mark.parametrize("method, endpoint", ENDPOINTS)
def test_nothing_is_left_behind_at_the_unprefixed_path(
    prefixed_client: TestClient, method: str, endpoint: str
):
    assert prefixed_client.request(method, endpoint).status_code == 404


@pytest.mark.parametrize("prefix", ["foo", "/foo/", "/", " /foo"])
def test_a_malformed_prefix_is_refused_by_the_settings(tmp_path: Path, prefix: str):
    with pytest.raises(ValidationError):
        Settings(destdir=anyio.Path(tmp_path), auth=AuthBackend.DISABLED, route_prefix=prefix)


@pytest.mark.parametrize("prefix", ["", "/foo", "/foo/bar", "/a-b_c"])
def test_a_well_formed_prefix_is_accepted_and_mounts(tmp_path: Path, prefix: str):
    settings = Settings(
        destdir=anyio.Path(tmp_path), auth=AuthBackend.DISABLED, route_prefix=prefix
    )

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
    assert upload(auth_client, provider.mint()).status_code == 204

    # the chunk lives under the subject digest, and is reachable through the readable
    # alias as well -- a shell user finding "lecturer-..." has to land on the real data
    assert upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST).is_file()
    assert upload_chunk_path(tmp_path, alias_of("lecturer", DEFAULT_SUBJECT_DIGEST)).is_file()
    assert len(list(tmp_path.rglob("chunk.*"))) == 1


def test_different_subjects_get_different_directories(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    assert upload(auth_client, provider.mint(sub="user-a"), index=0).status_code == 204
    assert upload(auth_client, provider.mint(sub="user-b"), index=1).status_code == 204

    assert upload_chunk_path(tmp_path, digest_of("user-a"), index=0).is_file()
    assert upload_chunk_path(tmp_path, digest_of("user-b"), index=1).is_file()


def test_a_username_from_userinfo_names_the_alias(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    provider.serve_userinfo(sub=DEFAULT_SUBJECT, preferred_username="dozentin")

    assert upload(auth_client, provider.mint(preferred_username=None)).status_code == 204

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
    return auth_client.post(render_url(recording), headers=headers, json={})


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
    assert upload(auth_client, token).status_code == 204

    assert schedule(auth_client, token).status_code == 202

    mock_postprocess.assert_called_once_with(tmp_path / DEFAULT_SUBJECT_DIGEST / "foo")


def test_a_job_cannot_name_another_subjects_recording(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the recording name is the caller's to choose and says nothing about whose it is, so
    # two lecturers naming a lecture alike is ordinary. What keeps them apart is that the
    # name is resolved under the caller's own home and nowhere else.
    mock_postprocess = mocker.patch("ise_record.glue.jobs.postprocess_recording", autospec=True)

    assert upload(auth_client, provider.mint(sub="user-a")).status_code == 204

    # a decoy at the destination root, so that this is the home directory being honored
    # rather than the recording merely being absent everywhere: an implementation that
    # resolved the name anywhere but under the caller's own home would find this one
    (tmp_path / "foo" / "stream").mkdir(parents=True)

    response = schedule(auth_client, provider.mint(sub="user-b"))

    assert response.status_code == 404
    mock_postprocess.assert_not_called()


def test_a_chunk_for_the_callers_own_recording_being_purged_is_refused(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    abandon_recording(home, "foo")

    with purge_in_flight(auth_client, home, "foo"):
        assert upload(auth_client, provider.mint(), index=7).status_code == 409

    assert not upload_chunk_path(tmp_path, DEFAULT_SUBJECT_DIGEST, index=7).exists()


def test_another_subjects_purge_does_not_block_a_recording_of_the_same_name(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the claims are kept per user, and the recording name alone says nothing about whose it is
    home_a = tmp_path / digest_of("user-a")
    abandon_recording(home_a, "foo")

    with purge_in_flight(auth_client, home_a, "foo"):
        assert upload(auth_client, provider.mint(sub="user-b")).status_code == 204
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


def test_the_listing_returns_the_recordings_with_size_and_a_download_link(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    finish_recording(home, "PSU_2026")

    response = list_recordings(auth_client, provider.mint())

    assert response.status_code == 200
    # the names the client has to send back to /api/recordings/{recording}, not the name of
    # the file inside each of them -- which is "presentation.webm" for every recording
    data = response.json()
    assert [(r["state"], r["name"], r["size"]) for r in data] == [
        ("completed", "GVS_2025", 5),
        ("completed", "PSU_2026", 5),
    ]
    # exactly the keys the frontend's schema expects, in its camelCase
    assert {frozenset(entry) for entry in data} == {
        frozenset({"state", "name", "size", "downloadUrl"})
    }
    # every link leads to its own recording, in the caller's enclave
    enclave = enclave_of(auth_client, home)
    for entry in data:
        user_digest, recording, totp = download_parts(entry)
        assert (user_digest, recording) == (DEFAULT_SUBJECT_DIGEST, entry["name"])
        assert enclave.verify_totp(totp, entry["name"])


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

    assert names(response.json(), "completed") == ["rendered"]


def test_the_listing_only_shows_the_callers_own_recordings(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / digest_of("user-a"), "mine")
    finish_recording(tmp_path / digest_of("user-b"), "theirs")

    assert [
        r["name"]
        for r in entries(
            list_recordings(auth_client, provider.mint(sub="user-a")).json(), "completed"
        )
    ] == ["mine"]
    assert [
        r["name"]
        for r in entries(
            list_recordings(auth_client, provider.mint(sub="user-b")).json(), "completed"
        )
    ] == ["theirs"]


# The listing also names the recordings that are still being postprocessed, so the frontend
# can show that a lecture is on its way rather than missing. What it reads is the per-user
# set of running jobs that /jobs marks a recording in for as long as its job lasts; a
# TestClient runs background tasks to completion before it returns, so the set is seeded by
# hand to catch a job mid-flight.


def test_the_listing_reports_nothing_rendering_when_no_job_is_running(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")

    data = list_recordings(auth_client, provider.mint()).json()

    # present and empty rather than absent, because the frontend schema requires the field
    assert names(data, "rendering") == []


def test_a_recording_in_postprocessing_is_listed_as_rendering(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    # a job only ever runs for a recording that is on disk -- /jobs refuses anything else --
    # and the listing classifies what it finds there
    abandon_recording(home, "PSU_2026")
    abandon_recording(home, "ABC_2026")

    with job_in_flight(auth_client, home, "PSU_2026"), job_in_flight(auth_client, home, "ABC_2026"):
        data = list_recordings(auth_client, provider.mint()).json()

    # the frontend renders the list as it comes, so the cards would shuffle between polls
    # without the sort
    assert names(data, "rendering") == ["ABC_2026", "PSU_2026"]
    # only the name: there is no file to size and nothing to download yet
    assert names(data, "completed") == ["GVS_2025"]


def test_a_recording_being_rerendered_is_only_listed_as_rendering(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the previous render stays on disk until the new one replaces it, so without the
    # filter the recording would show up twice: a download card and a spinner side by side
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    finish_recording(home, "PSU_2026")

    with job_in_flight(auth_client, home, "PSU_2026"):
        data = list_recordings(auth_client, provider.mint()).json()

    assert names(data, "completed") == ["GVS_2025"]
    assert names(data, "rendering") == ["PSU_2026"]


def test_a_rerendered_recording_is_offered_for_download_again_once_the_job_is_done(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the job letting go of the recording is all it takes; a failed rerender leaves the
    # previous render in place, so this holds either way
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    token = provider.mint()

    with job_in_flight(auth_client, home, "GVS_2025"):
        assert names(list_recordings(auth_client, token).json(), "completed") == []

    data = list_recordings(auth_client, token).json()

    assert names(data, "completed") == ["GVS_2025"]
    assert names(data, "rendering") == []


def test_the_listing_only_shows_the_callers_own_rendering_jobs(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home_a = tmp_path / digest_of("user-a")
    abandon_recording(home_a, "mine")

    with job_in_flight(auth_client, home_a, "mine"):
        assert names(
            list_recordings(auth_client, provider.mint(sub="user-a")).json(), "rendering"
        ) == ["mine"]
        assert (
            names(list_recordings(auth_client, provider.mint(sub="user-b")).json(), "rendering")
            == []
        )


def test_a_scheduled_job_is_rendering_where_the_listing_looks_for_it(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the scheduling and the listing endpoint have to agree on which enclave a job is claimed
    # in; a job claimed anywhere else would render without ever showing up in the listing
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    seen_while_running: list[RecordingActivity] = []

    async def fake_postprocess(_recording_path: Path) -> Result:
        seen_while_running.append(activity_of(auth_client, home, "foo"))
        return Result(output_file=None, reason=ResultReason.SUCCESS)

    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording", autospec=True, side_effect=fake_postprocess
    )

    token = provider.mint()
    assert upload(auth_client, token).status_code == 204
    assert schedule(auth_client, token).status_code == 202

    assert seen_while_running == [RecordingActivity.RENDERING]
    # and gone again once it finished, or the card would spin forever
    assert names(list_recordings(auth_client, token).json(), "rendering") == []


def test_a_job_that_blows_up_still_releases_the_recording(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # otherwise one unexpected failure locks that recording out of postprocessing and purging
    # until the server is restarted, and rerender.py is the only way back
    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        side_effect=RuntimeError("boom"),
    )
    token = provider.mint()
    assert upload(auth_client, token).status_code == 204

    # the 202 is already out by then; a TestClient hands what the task raised on to the test
    with pytest.raises(RuntimeError):
        schedule(auth_client, token)

    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    assert activity_of(auth_client, home, "foo") == RecordingActivity.NONE


def test_a_render_whose_answer_fails_gives_the_recording_back(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    # the endpoint has handed the claim to its job by then, but the job only starts once the
    # answer is out. Left with a job that never runs, the claim would keep the recording from
    # being purged or rendered again until the server is restarted.
    abandon_recording(settings.destdir, "foo")
    mock_postprocess = mocker.patch("ise_record.glue.jobs.postprocess_recording", autospec=True)
    mocker.patch(
        "ise_record.server.UnfinishedRecording.model_construct", return_value="not a recording"
    )

    with pytest.raises(ResponseValidationError):
        client.post(render_url("foo"), json={})

    mock_postprocess.assert_not_called()
    assert activity_of(client, settings.destdir, "foo") == RecordingActivity.NONE


# --- handing the rendering claim over to the job ---------------------------
#
# Driven directly rather than through a request: FastAPI tears the dependency down after the job
# has run, but that order is FastAPI's business and has changed between versions. These pin that
# the claim is given up exactly once, and not before the job is done, whichever comes first.


class Releases:
    """Counts how often the claim it stands in for is given up."""

    def __init__(self) -> None:
        self.count = 0

    def __call__(self) -> None:
        self.count += 1


async def claim_in_endpoint(
    releases: Releases,
) -> tuple[AsyncGenerator[HandoverExitStacks], HandoverExitStacks]:
    """Start the dependency, and take a claim in the endpoint as the render endpoint does."""
    dependency = _get_request_exit_stacks()
    stacks = await anext(dependency)
    stacks.in_endpoint.callback(releases)
    return dependency, stacks


async def finish_request(dependency: AsyncGenerator[HandoverExitStacks]) -> None:
    """Tear the dependency down as FastAPI does after a request without errors."""
    with pytest.raises(StopAsyncIteration):
        await anext(dependency)


@pytest.mark.asyncio
async def test_a_claim_handed_to_the_job_outlasts_the_request_if_the_request_ends_first():
    releases = Releases()
    dependency, stacks = await claim_in_endpoint(releases)
    handed = stacks.handover()

    await finish_request(dependency)
    assert releases.count == 0

    with handed:  # the job runs
        pass
    assert releases.count == 1


@pytest.mark.asyncio
async def test_a_claim_handed_to_a_job_that_never_starts_is_given_up_with_the_request():
    # an error after the endpoint -- the answer failing, say -- and FastAPI never starts the job
    releases = Releases()
    dependency, stacks = await claim_in_endpoint(releases)
    stacks.handover()

    with pytest.raises(ValueError):
        await dependency.athrow(ValueError("the answer failed"))

    assert releases.count == 1


@pytest.mark.asyncio
async def test_a_claim_is_given_up_once_when_the_job_fails_after_it_ran():
    # FastAPI hands what the job raised on to the dependency, by which time the job has given
    # the claim up itself
    releases = Releases()
    dependency, stacks = await claim_in_endpoint(releases)
    handed = stacks.handover()

    with pytest.raises(RuntimeError), handed:  # the job runs and blows up
        raise RuntimeError("boom")
    with pytest.raises(RuntimeError):
        await dependency.athrow(RuntimeError("boom"))

    assert releases.count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("refused", [False, True])
async def test_a_claim_never_handed_over_is_given_up_with_the_request(refused: bool):
    # the endpoint turned the job away, or never got as far as handing the claim over
    releases = Releases()
    dependency, _ = await claim_in_endpoint(releases)

    if refused:
        with pytest.raises(HTTPException):
            await dependency.athrow(HTTPException(status_code=404))
    else:
        await finish_request(dependency)

    assert releases.count == 1


class WatchedSlots:
    """Stands in for the app's semaphore and notes the recording's activity when a job asks for a slot."""

    def __init__(self, look: Callable[[], RecordingActivity]) -> None:
        self._look = look
        self.seen_when_asked: list[RecordingActivity] = []

    async def __aenter__(self) -> None:
        self.seen_when_asked.append(self._look())

    async def __aexit__(self, *_exc_info: object) -> None:
        return None


def test_a_job_waiting_for_a_slot_already_counts_as_rendering(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # While it waits, the listing shows it as rendering and it cannot be purged -- both of
    # which ask for the recording's activity. A recording that was only claimed once it got
    # its slot could be purged just before its render starts reading it.
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        return_value=Result(output_file=None, reason=ResultReason.SUCCESS),
    )
    slots = WatchedSlots(lambda: activity_of(auth_client, home, "foo"))
    app_of(auth_client).state.jobs_semaphore = slots

    token = provider.mint()
    assert upload(auth_client, token).status_code == 204
    assert schedule(auth_client, token).status_code == 202

    assert slots.seen_when_asked == [RecordingActivity.RENDERING]


def test_a_finished_job_leaves_another_users_recording_of_the_same_name_rendering(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # two lecturers naming a lecture alike is ordinary; one of them finishing must not make
    # the other's look idle
    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        return_value=Result(output_file=None, reason=ResultReason.SUCCESS),
    )
    home_a, home_b = tmp_path / digest_of("user-a"), tmp_path / digest_of("user-b")
    abandon_recording(home_a, "foo")
    abandon_recording(home_b, "foo")

    with job_in_flight(auth_client, home_a, "foo"):
        assert schedule(auth_client, provider.mint(sub="user-b")).status_code == 202

        assert activity_of(auth_client, home_a, "foo") == RecordingActivity.RENDERING
        assert activity_of(auth_client, home_b, "foo") == RecordingActivity.NONE


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
    assert names(data, "unprocessed") == ["GVS_2025"]
    assert names(data, "completed") == ["DONE_2025"]
    assert names(data, "rendering") == []


def test_the_listing_reports_no_unprocessed_recordings_when_there_are_none(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "DONE_2025")

    # present and empty rather than absent, because the frontend schema requires the field
    assert names(list_recordings(auth_client, provider.mint()).json(), "unprocessed") == []


def test_the_listing_only_shows_the_callers_own_unprocessed_recordings(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    abandon_recording(tmp_path / digest_of("user-a"), "mine")
    abandon_recording(tmp_path / digest_of("user-b"), "theirs")

    assert names(
        list_recordings(auth_client, provider.mint(sub="user-a")).json(), "unprocessed"
    ) == ["mine"]
    assert names(
        list_recordings(auth_client, provider.mint(sub="user-b")).json(), "unprocessed"
    ) == ["theirs"]


def test_a_rerendered_recording_moves_from_unprocessed_to_rendering(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # what the lecturer sees after pressing Rerender on a failed card: the card turns into
    # a spinner rather than showing up twice
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    recording_dir = abandon_recording(home, "GVS_2025")
    token = provider.mint()

    assert names(list_recordings(auth_client, token).json(), "unprocessed") == ["GVS_2025"]

    with job_in_flight(auth_client, home, recording_dir.name):
        data = list_recordings(auth_client, token).json()

    assert names(data, "unprocessed") == []
    assert names(data, "rendering") == ["GVS_2025"]


def test_a_completed_recording_can_be_downloaded(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025", b"the rendered lecture")

    server_list = list_recordings(auth_client, provider.mint()).json()

    response = follow_download(auth_client, entries(server_list, "completed")[0])

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
    # the name is percent-encoded in the link and decoded on the way back in, and
    # SafeRecording runs over it a second time -- a stored name has to be a fixed point of
    # that validator or the listing offers links that 404
    finish_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, recording)
    token = provider.mint()

    server_list = list_recordings(auth_client, token).json()

    assert entries(server_list, "completed")[0]["name"] == recording

    response = follow_download(auth_client, entries(server_list, "completed")[0])

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

    user_digest, _, totp = download_parts(entries(server_list, "completed")[0])
    response = download_completed(auth_client, user_digest, "U\u0308bung_2025", totp)

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
    _, _, totp = download_parts(entries(server_list, "completed")[0])
    response = download_completed(auth_client, user_digest, "GVS_2025", totp)

    assert response.status_code in (404, 422)
    assert b"video" not in response.content


def test_downloading_is_forbidden_without_authentication(client: TestClient, settings: Settings):
    # the counterpart of the listing test above, on the route that actually serves bytes:
    # an unauthenticated deployment has one shared destdir and nobody to own a recording
    finish_recording(settings.destdir, "GVS_2025")

    response = client.get("/api/downloads/deadbeef/GVS_2025", params={"totp": "0000000000"})

    assert response.status_code == 403
    assert b"video" not in response.content


# --- download OTPs through the endpoints -----------------------------------

# The properties from core/test_auth_download.py, restated over a real request, because what
# the download route verifies against is put together from two segments the caller supplies:
# the digest picks the enclave, whose authority checks the OTP against the recording name.


def test_a_totp_is_scoped_to_the_one_recording_it_was_issued_for(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    finish_recording(home, "PSU_2026", b"the other lecture")

    server_list = list_recordings(auth_client, provider.mint()).json()
    by_name = {rec["name"]: download_parts(rec) for rec in entries(server_list, "completed")}
    user_digest, _, gvs_totp = by_name["GVS_2025"]

    response = download_completed(auth_client, user_digest, "PSU_2026", gvs_totp)

    assert response.status_code == 401
    assert b"the other lecture" not in response.content


def test_a_totp_does_not_open_another_subjects_recording(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    finish_recording(tmp_path / digest_of("user-a"), "shared_name")
    finish_recording(tmp_path / digest_of("user-b"), "shared_name", b"not yours")

    server_list = list_recordings(auth_client, provider.mint(sub="user-a")).json()

    # the digest is a path segment the caller supplies, so the OTP has to be tied to the
    # enclave it names rather than to the recording name both of them happen to use
    _, _, totp = download_parts(entries(server_list, "completed")[0])
    response = download_completed(auth_client, digest_of("user-b"), "shared_name", totp)

    assert response.status_code == 401
    assert b"not yours" not in response.content


def test_a_totp_does_not_open_the_recording_of_another_subject_who_has_listed_theirs(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the same, once user-b has an enclave and an OTP of their own for the same name: the
    # link's digest picks user-b's authority, which never issued user-a's OTP
    finish_recording(tmp_path / digest_of("user-a"), "shared_name")
    finish_recording(tmp_path / digest_of("user-b"), "shared_name", b"not yours")

    server_list = list_recordings(auth_client, provider.mint(sub="user-a")).json()
    list_recordings(auth_client, provider.mint(sub="user-b"))

    _, _, totp = download_parts(entries(server_list, "completed")[0])
    response = download_completed(auth_client, digest_of("user-b"), "shared_name", totp)

    assert response.status_code == 401
    assert b"not yours" not in response.content


def test_a_link_for_a_user_nobody_has_seen_is_refused_like_a_wrong_totp(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # Whether a digest has an enclave says which lecturers used the server since it started.
    # Both refusals look the same, so a link guessed at says nothing about that.
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")
    finish_recording(tmp_path / digest_of("nobody"), "GVS_2025")
    list_recordings(auth_client, provider.mint())

    wrong_totp = download_completed(auth_client, DEFAULT_SUBJECT_DIGEST, "GVS_2025", "0000000000")
    unknown_user = download_completed(auth_client, digest_of("nobody"), "GVS_2025", "0000000000")

    assert wrong_totp.status_code == unknown_user.status_code == 401
    assert wrong_totp.json() == unknown_user.json()


def test_following_a_download_link_makes_no_enclave(auth_client: TestClient):
    # the download route takes no token, so anybody can make it look a digest up
    download_completed(auth_client, digest_of("nobody"), "GVS_2025", "0000000000")

    assert app_of(auth_client).state.enclaves == {}


def test_a_recording_that_was_never_listed_cannot_be_downloaded(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "listed")
    finish_recording(home, "never_listed", b"secret lecture")

    # only one of them is ever listed, so the other never gets a generator
    server_list = list_recordings(auth_client, provider.mint()).json()

    user_digest, _, totp = download_parts(entries(server_list, "completed")[0])
    response = download_completed(auth_client, user_digest, "never_listed", totp)

    assert response.status_code == 401
    assert b"secret lecture" not in response.content


def test_a_totp_from_an_earlier_interval_is_refused_by_the_endpoint(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")

    list_recordings(auth_client, provider.mint())

    generator = otp_generator_of(auth_client, home, "GVS_2025")
    three_intervals = datetime.timedelta(seconds=3 * generator.interval)
    three_intervals_ago = datetime.datetime.now(datetime.UTC) - three_intervals
    stale = generator.at(three_intervals_ago)

    response = download_completed(auth_client, DEFAULT_SUBJECT_DIGEST, "GVS_2025", stale)

    assert response.status_code == 401
    assert b"video" not in response.content


def test_a_totp_from_the_previous_interval_is_accepted_by_the_endpoint(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the link the page shows is up to one poll old, and that poll may have been on the other
    # side of an interval boundary
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    finish_recording(home, "GVS_2025")

    list_recordings(auth_client, provider.mint())

    generator = otp_generator_of(auth_client, home, "GVS_2025")
    one_interval = datetime.timedelta(seconds=generator.interval)
    one_interval_ago = datetime.datetime.now(datetime.UTC) - one_interval
    previous = generator.at(one_interval_ago)

    response = download_completed(auth_client, DEFAULT_SUBJECT_DIGEST, "GVS_2025", previous)

    assert response.status_code == 200


# --- purging a recording ---------------------------------------------------

# The one endpoint that destroys data, and irreversibly. Every refusal below checks the disk
# rather than only the status code: a 4xx that had already deleted something would pass a
# status check just fine. Which recordings count as purgeable is get_purgeable_recordings'
# business, in glue/test_recording_lists.py; these pin what the endpoint does with the answer.


def snapshot(root: Path | anyio.Path) -> dict[str, bytes]:
    """Every file under root with its content, following no symlinks."""
    root = Path(root)
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file() and not p.is_symlink()
    }


def rendered_recording(home: Path | anyio.Path, name: str) -> Path:
    """A recording as it looks after a successful render: chunks, output, leftovers."""
    recording_dir = Path(home) / name
    write_chunks(recording_dir, [30 * 60, 29 * 60])
    write_chunks(recording_dir, [30 * 60], track="overlay")
    (recording_dir / "presentation.webm").write_bytes(b"the rendered lecture")
    return recording_dir


def test_a_purge_deletes_the_whole_recording(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    recording_dir = rendered_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")

    response = purge(auth_client, provider.mint(), "GVS_2025")

    assert response.status_code == 204
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
    assert purge(auth_client, provider.mint(), "GVS_2025").status_code == 204

    expected = {
        k: v for k, v in before.items() if not k.startswith(f"{DEFAULT_SUBJECT_DIGEST}/GVS_2025/")
    }
    assert snapshot(tmp_path) == expected


def test_a_purged_recording_leaves_the_listing(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    rendered_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")
    token = provider.mint()

    assert names(list_recordings(auth_client, token).json(), "completed") == ["GVS_2025"]
    assert purge(auth_client, token, "GVS_2025").status_code == 204

    assert list_recordings(auth_client, token).json() == []


def test_a_purge_answers_with_nothing(auth_client: TestClient, provider: Provider, tmp_path: Path):
    # the frontend drops the card from its copy of the listing, and the next poll agrees
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "GVS_2025")
    rendered_recording(home, "PSU_2026")

    response = purge(auth_client, provider.mint(), "GVS_2025")

    assert response.status_code == 204
    assert response.content == b""


def test_a_refused_purge_answers_with_the_reason(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the frontend rolls its optimistic removal back on this, and shows the detail
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    abandon_recording(home, "BUSY_2025")

    with job_in_flight(auth_client, home, "BUSY_2025"):
        response = purge(auth_client, provider.mint(), "BUSY_2025")

    assert response.status_code == 409
    assert set(response.json()) == {"detail"}


def test_a_purged_recording_takes_its_download_otp_with_it(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "GVS_2025")
    token = provider.mint()
    server_list = list_recordings(auth_client, token).json()

    assert purge(auth_client, token, "GVS_2025").status_code == 204

    # a lecture recorded again under the same name must not be downloadable with a link
    # that was handed out for the one that was purged
    rendered_recording(home, "GVS_2025")
    response = follow_download(auth_client, entries(server_list, "completed")[0])

    assert response.status_code == 401


def test_an_unprocessed_recording_can_be_purged(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the other card that offers Purge: a render that failed, with no output to show for it
    recording_dir = abandon_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "GVS_2025")
    (recording_dir / "presentation.part.webm").write_bytes(b"half")

    assert purge(auth_client, provider.mint(), "GVS_2025").status_code == 204
    assert not recording_dir.exists()


def test_a_decomposed_name_purges_the_composed_recording(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the same normalization as on upload and download, so the purge hits the recording the
    # lecturer saw rather than 404ing on a macOS client
    recording_dir = rendered_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "\u00dcbung_2025")

    assert purge(auth_client, provider.mint(), "U\u0308bung_2025").status_code == 204
    assert not recording_dir.exists()


def test_a_purge_is_logged_with_the_user_who_asked(
    auth_client: TestClient, provider: Provider, tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    # nothing else is left afterwards to say where the recording went
    rendered_recording(tmp_path / digest_of("user-a"), "GVS_2025")

    with caplog.at_level("INFO", logger="ise_record"):
        assert purge(auth_client, provider.mint(sub="user-a"), "GVS_2025").status_code == 204

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
    rendered_recording(home, "GVS_2025")
    before = snapshot(tmp_path)

    with job_in_flight(auth_client, home, "GVS_2025"):
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


# --- what the job endpoint answers with ---------------------------------------


def test_a_scheduled_job_answers_with_the_recording_now_rendering(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the frontend puts this straight into its copy of the listing in place of the card it had
    mocker.patch("ise_record.glue.jobs.postprocess_recording", autospec=True)
    abandon_recording(tmp_path / DEFAULT_SUBJECT_DIGEST, "foo")

    response = schedule(auth_client, provider.mint())

    assert response.status_code == 202
    assert response.json() == {"state": "rendering", "name": "foo"}


def test_a_job_in_an_open_deployment_answers_like_anywhere_else(
    mocker: MockerFixture, client: TestClient, settings: Settings
):
    # the answer says nothing the caller did not know: the name is theirs, and that it is
    # rendering is what the 202 means. So there is no reason to withhold it where the listing
    # is refused.
    mocker.patch("ise_record.glue.jobs.postprocess_recording", autospec=True)
    abandon_recording(settings.destdir, "foo")

    response = client.post(render_url("foo"), json={})

    assert response.status_code == 202
    assert response.json() == {"state": "rendering", "name": "foo"}


def test_a_duplicate_job_is_refused_without_disturbing_the_first(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # starting it would have two renders write over each other's assembled tracks. Refused
    # like any other conflict; the lecturer can see the first one rendering in the listing.
    mock_postprocess = mocker.patch("ise_record.glue.jobs.postprocess_recording", autospec=True)
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    abandon_recording(home, "foo")

    with job_in_flight(auth_client, home, "foo"):
        response = schedule(auth_client, provider.mint())

        assert response.status_code == 409
        mock_postprocess.assert_not_called()
        # still the first job's: the refusal does not let go of a claim it never had
        assert activity_of(auth_client, home, "foo") == RecordingActivity.RENDERING


# --- requests that arrive while another one is in flight -----------------------
#
# A TestClient serves one request at a time unless one of them waits on a worker thread, which
# leaves the event loop free for the next. Each test below sends its second request from inside
# such a thread, so the two really overlap: the rmtree of a purge, or one of the filesystem calls
# that anyio.Path hands to a worker thread while a classification or a listing awaits it.


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def arriving_during(
    mocker: MockerFixture, method: str, path: Path, request: Callable[[], Response]
) -> list[Response]:
    """
    Send `request` from inside the first call of pathlib.Path.<method> on `path`.

    anyio.Path runs its pathlib counterpart in a worker thread, so that call is a point where
    the request under test is suspended on the filesystem. The response lands in the list.
    """
    real = getattr(Path, method)
    during: list[Response] = []
    arrived = False

    def arriving(self: Path, *args: object, **kwargs: object) -> object:
        # only once: the second request may well make the same call on the same path
        nonlocal arrived
        if not arrived and self == path:
            arrived = True
            during.append(request())
        return real(self, *args, **kwargs)

    mocker.patch.object(Path, method, autospec=True, side_effect=arriving)
    return during


# How long a request sent during a purge gets to come back before rmtree goes on. One held up by
# the purge is still out after that; one that does not wait for it is back in a fraction of this.
UNHINDERED_ANSWER_SECONDS = 0.5
# Upper bound for a request to come back once nothing holds it up any more, so that a deadlock
# fails the test instead of hanging the suite
ANSWER_TIMEOUT_SECONDS = 10.0


class RequestInThread:
    """
    A request sent from a thread of its own, for requests that arrive during a purge and have to
    wait for it: sent from inside rmtree itself, the request would wait for the purge, and the
    purge for rmtree, which waits for the request.
    """

    def __init__(self, request: Callable[[], Response]) -> None:
        self._request = request
        self._response: Response | None = None
        self._thread = threading.Thread(target=self._send, daemon=True)

    def _send(self) -> None:
        self._response = self._request()

    def start(self) -> None:
        """Send the request"""
        self._thread.start()

    def answered_within(self, seconds: float) -> bool:
        """Wait up to `seconds` for the answer; whether it came"""
        self._thread.join(seconds)
        return not self._thread.is_alive()

    def response(self) -> Response:
        """The answer, once it is there"""
        assert self.answered_within(ANSWER_TIMEOUT_SECONDS), "request never came back"
        assert self._response is not None, "request raised instead of answering"
        return self._response


def test_a_job_for_a_recording_being_purged_is_refused(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # it would render a directory while rmtree takes it apart
    mock_postprocess = mocker.patch("ise_record.glue.jobs.postprocess_recording", autospec=True)
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "foo")
    token = provider.mint()
    during: list[Response] = []
    real_rmtree = shutil.rmtree

    def rmtree_with_a_job_arriving(path: Path) -> None:
        during.append(schedule(auth_client, token))
        real_rmtree(path)

    mocker.patch("ise_record.glue.enclave.shutil.rmtree", side_effect=rmtree_with_a_job_arriving)

    assert purge(auth_client, token, "foo").status_code == 204

    assert during[0].status_code == 409
    mock_postprocess.assert_not_called()
    assert activity_of(auth_client, home, "foo") == RecordingActivity.NONE


def test_a_chunk_for_a_recording_being_purged_is_refused(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # it would land in a directory rmtree has already been through, and either make the purge
    # fail with a directory that is not empty or be deleted along with everything else
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "foo")
    token = provider.mint()
    during: list[Response] = []
    real_rmtree = shutil.rmtree

    def rmtree_with_a_chunk_arriving(path: Path) -> None:
        during.append(upload(auth_client, token, index=7))
        real_rmtree(path)

    mocker.patch("ise_record.glue.enclave.shutil.rmtree", side_effect=rmtree_with_a_chunk_arriving)

    assert purge(auth_client, token, "foo").status_code == 204

    assert during[0].status_code == 409
    assert not (home / "foo").exists()


def test_a_second_purge_of_the_same_recording_is_refused_rather_than_failing(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # two tabs, or a double click: both would get as far as rmtree, and the second would find
    # the directory gone and answer with a 500
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "GVS_2025")
    token = provider.mint()
    during: list[Response] = []
    real_rmtree = shutil.rmtree

    def rmtree_with_another_purge_arriving(path: Path) -> None:
        during.append(purge(auth_client, token, "GVS_2025"))
        real_rmtree(path)

    mocker.patch(
        "ise_record.glue.enclave.shutil.rmtree", side_effect=rmtree_with_another_purge_arriving
    )

    assert purge(auth_client, token, "GVS_2025").status_code == 204

    assert during[0].status_code == 409


def test_a_job_arriving_while_the_purge_classifies_is_refused(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the purge's look at the recording awaits the filesystem as well, and comes before rmtree;
    # a job let in there would be rendering by the time rmtree starts. Its first look is
    # whether the recording is a directory.
    mock_postprocess = mocker.patch("ise_record.glue.jobs.postprocess_recording", autospec=True)
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "foo")
    token = provider.mint()
    during = arriving_during(mocker, "is_dir", home / "foo", lambda: schedule(auth_client, token))

    assert purge(auth_client, token, "foo").status_code == 204

    assert during[0].status_code == 409
    mock_postprocess.assert_not_called()
    assert not (home / "foo").exists()


def test_a_purge_arriving_while_the_job_looks_at_the_recording_is_refused(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the job looks at the disk before it accepts, and that look awaits the filesystem; a purge
    # let in there would delete the recording the job then goes on to render. Its first look is
    # whether the recording is a directory.
    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        return_value=Result(output_file=None, reason=ResultReason.SUCCESS),
    )
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    abandon_recording(home, "foo")
    token = provider.mint()
    during = arriving_during(
        mocker, "is_dir", home / "foo", lambda: purge(auth_client, token, "foo")
    )

    assert schedule(auth_client, token).status_code == 202

    assert during[0].status_code == 409
    assert (home / "foo" / "stream").is_dir()


def test_the_listing_leaves_out_a_recording_while_it_is_purged(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the frontend removed the card when the purge was confirmed; the minute poll, or another
    # tab, must not bring it back half-deleted. Nor may it look at the files while rmtree takes
    # them away, so it waits for the purge and lists what is left after it.
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "GVS_2025")
    rendered_recording(home, "PSU_2026")
    token = provider.mint()
    listing = RequestInThread(lambda: list_recordings(auth_client, token))
    answered_before_rmtree: list[bool] = []
    real_rmtree = shutil.rmtree

    def rmtree_with_a_listing_arriving(path: Path) -> None:
        listing.start()
        answered_before_rmtree.append(listing.answered_within(UNHINDERED_ANSWER_SECONDS))
        real_rmtree(path)

    mocker.patch(
        "ise_record.glue.enclave.shutil.rmtree", side_effect=rmtree_with_a_listing_arriving
    )

    assert purge(auth_client, token, "GVS_2025").status_code == 204

    assert answered_before_rmtree == [False]
    data = listing.response().json()
    assert names(data, "completed") == ["PSU_2026"]
    assert names(data, "rendering") == [] and names(data, "unprocessed") == []


def test_another_recording_still_takes_a_job_while_one_is_purged(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        return_value=Result(output_file=None, reason=ResultReason.SUCCESS),
    )
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "GVS_2025")
    abandon_recording(home, "foo")
    token = provider.mint()
    job = RequestInThread(lambda: schedule(auth_client, token, "foo"))
    real_rmtree = shutil.rmtree

    def rmtree_with_a_job_for_another_arriving(path: Path) -> None:
        # the job may have to wait for the purge before it looks at the disk; that is fine, as
        # long as it is taken in the end rather than refused
        job.start()
        job.answered_within(UNHINDERED_ANSWER_SECONDS)
        real_rmtree(path)

    mocker.patch(
        "ise_record.glue.enclave.shutil.rmtree",
        side_effect=rmtree_with_a_job_for_another_arriving,
    )

    assert purge(auth_client, token, "GVS_2025").status_code == 204

    assert job.response().status_code == 202


def test_the_name_takes_uploads_again_once_the_purge_is_done(
    auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the re-upload a lecturer starts right after purging the previous one
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    rendered_recording(home, "foo")
    token = provider.mint()

    assert purge(auth_client, token, "foo").status_code == 204
    assert upload(auth_client, token).status_code == 204
    assert activity_of(auth_client, home, "foo") == RecordingActivity.NONE


def test_a_duplicate_job_arriving_while_the_first_looks_at_the_recording_starts_no_second_render(
    mocker: MockerFixture, auth_client: TestClient, provider: Provider, tmp_path: Path
):
    # the first job claims the recording before it looks at the disk, so a retry that comes in
    # while it looks finds the recording claimed
    mock_postprocess = mocker.patch(
        "ise_record.glue.jobs.postprocess_recording",
        autospec=True,
        return_value=Result(output_file=None, reason=ResultReason.SUCCESS),
    )
    home = tmp_path / DEFAULT_SUBJECT_DIGEST
    abandon_recording(home, "foo")
    token = provider.mint()
    # into the first job's look at whether the recording is a directory; the duplicate looks
    # too, and that one goes ahead undisturbed
    during = arriving_during(mocker, "is_dir", home / "foo", lambda: schedule(auth_client, token))

    assert schedule(auth_client, token).status_code == 202

    assert during[0].status_code == 409
    mock_postprocess.assert_called_once()


def test_cors_preflight_allows_uploading(tmp_path: Path):
    # without PUT here the browser refuses every chunk upload before it is sent, whenever the
    # frontend is served from another origin than the backend
    cors_settings = Settings(
        destdir=anyio.Path(tmp_path),
        auth=AuthBackend.DISABLED,
        cors_origins=("http://allowed.example.com",),
    )

    with TestClient(create_app(cors_settings)) as cors_client:
        response = cors_client.options(
            chunk_url("GVS_2025", "stream", 0),
            headers={
                "Origin": "http://allowed.example.com",
                "Access-Control-Request-Method": "PUT",
                "Access-Control-Request-Headers": "Authorization, Content-Type",
            },
        )

    assert response.status_code == 200
    assert "PUT" in response.headers["Access-Control-Allow-Methods"]
    assert "content-type" in response.headers["Access-Control-Allow-Headers"].lower()


def test_cors_preflight_allows_purging(tmp_path: Path):
    # without DELETE here the browser refuses the request before it is sent, whenever the
    # frontend is served from another origin than the backend
    cors_settings = Settings(
        destdir=anyio.Path(tmp_path),
        auth=AuthBackend.DISABLED,
        cors_origins=("http://allowed.example.com",),
    )

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
