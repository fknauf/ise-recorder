"""
The pieces shared by every test module that drives an authenticated backend.

`conftest.py` turns most of this into fixtures; what stays here is what a test file has to
name directly -- the Provider type in a signature, and the small functions that spell out
what the server does with a token, so an assertion can say what it expects instead of
recomputing it.

The naming helpers deliberately restate core/user_home.py's scheme rather than importing it: a test
that derived the expected directory name from the code under test would agree with any
change to it, including the ones that would move a lecturer's recordings.

The app works on anyio.Path, whose filesystem methods are coroutines. The helpers here set up
and inspect the filesystem synchronously, so they take either kind of path and convert it to
a pathlib.Path first; a sync call on an anyio.Path would only make a coroutine and not run it.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-class-docstring
# pylint: disable=missing-function-docstring
# pylint: disable=too-many-instance-attributes

from contextlib import AbstractContextManager
from datetime import datetime, timedelta, UTC
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import threading
import time
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

import anyio
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
import jwt
import pyotp

from ise_record.core.recordings import RecordingActivity
from ise_record.glue.enclave import Enclave
from ise_record.settings import get_settings, Settings

CLIENT_ID = "ise-recorder"
# Distinct from CLIENT_ID on purpose, and that is the normal deployment: an OIDC ID token's
# `aud` is the client id, an access token's names the resource server, so a backend with an
# audience of its own never sees an ID token pass. compose-with-auth.yml configures exactly
# this pair. Only the test that is about a provider collapsing the two sets them equal.
AUDIENCE = "ise-recorder-api"
DEFAULT_SUBJECT = "b472c41f9b227e6596e921541f46dc9d7"
ASSETS = Path(__file__).parent / "assets"
# NAME_MAX on ext4, and what pathvalidate caps a filename at on every platform it knows. The
# app does not name this number -- it relies on pathvalidate's default -- so the bound is
# pinned by test_the_effective_length_bound_is_the_one_the_filesystem_has in
# glue/test_models.py rather than shared with the code.
NAME_MAX_BYTES = 255


def make_key(kid: str) -> tuple[rsa.RSAPrivateKey, dict[str, Any]]:
    """Generate an RSA key pair and the JWK describing its public half"""
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True)  # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType, reportAttributeAccessIssue]
    jwk.update({"kid": kid, "use": "sig", "alg": "RS256"})  # pyright: ignore[reportUnknownMemberType]
    return private_key, jwk  # pyright: ignore[reportUnknownVariableType]


# A 2048-bit key takes a good part of a second to generate, and nearly every test against an
# authenticated backend starts a provider with one. Each provider has a server of its own, so
# sharing the key behind a kid between them is invisible to the tests; one that needs a key the
# provider does not know calls make_key directly.
_PROVIDER_KEYS: dict[str, tuple[rsa.RSAPrivateKey, dict[str, Any]]] = {}


def provider_key(kid: str) -> tuple[rsa.RSAPrivateKey, dict[str, Any]]:
    """The key pair a Provider signs with under `kid`, generated once per test session"""
    if kid not in _PROVIDER_KEYS:
        _PROVIDER_KEYS[kid] = make_key(kid)
    private_key, jwk = _PROVIDER_KEYS[kid]
    # a copy of the JWK, so a test that edits one provider's key set leaves the next one's alone
    return private_key, dict(jwk)


class Provider:
    """A stand-in OpenID provider serving discovery and JWKS documents over HTTP"""

    def __init__(self) -> None:
        self.keys: dict[str, tuple[rsa.RSAPrivateKey, dict[str, Any]]] = {}
        self.jwks_available = True
        self.jwks_fetch_count = 0
        # how long the JWKS endpoint takes to answer, for a provider that is slow or far away
        self.jwks_delay_seconds = 0.0
        # None means the endpoint 404s: a provider that has nothing to say about the caller
        self.userinfo_response: tuple[int, str, bytes] | None = None
        self.userinfo_fetch_count = 0
        self.userinfo_authorization: str | None = None
        # userinfo_endpoint is only RECOMMENDED in OIDC Discovery 1.0, so a conforming
        # provider may leave it out
        self.advertise_userinfo = True
        self.signing_algorithms: list[Any] = ["RS256"]
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def issuer(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_port}"

    def add_key(self, kid: str) -> None:
        self.keys[kid] = provider_key(kid)

    def start(self) -> None:
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # pylint: disable=invalid-name
                if self.path.endswith("/.well-known/openid-configuration"):
                    metadata: dict[str, Any] = {
                        "issuer": provider.issuer,
                        "authorization_endpoint": f"{provider.issuer}/authorize",
                        "token_endpoint": f"{provider.issuer}/token",
                        "jwks_uri": f"{provider.issuer}/jwks",
                        "id_token_signing_alg_values_supported": provider.signing_algorithms,
                    }
                    if provider.advertise_userinfo:
                        metadata["userinfo_endpoint"] = f"{provider.issuer}/userinfo"
                    return provider.respond(self, metadata)

                if self.path.endswith("/jwks"):
                    provider.jwks_fetch_count += 1
                    time.sleep(provider.jwks_delay_seconds)
                    if not provider.jwks_available:
                        self.send_response(503)
                        self.end_headers()
                        return None
                    return provider.respond(
                        self, {"keys": [jwk for _, jwk in provider.keys.values()]}
                    )

                if self.path.endswith("/userinfo"):
                    provider.userinfo_fetch_count += 1
                    provider.userinfo_authorization = self.headers.get("Authorization")
                    if provider.userinfo_response is None:
                        self.send_response(404)
                        self.end_headers()
                        return None
                    return provider.respond_raw(self, *provider.userinfo_response)

                self.send_response(404)
                self.end_headers()
                return None

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        # serve_forever polls for the shutdown flag, and defaults to doing so twice a
        # second -- which every test would then wait out in teardown
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self._thread.start()

    @staticmethod
    def respond(handler: BaseHTTPRequestHandler, body: dict[str, Any]) -> None:
        Provider.respond_raw(handler, 200, "application/json", json.dumps(body).encode())

    @staticmethod
    def respond_raw(
        handler: BaseHTTPRequestHandler, status: int, content_type: str, body: bytes
    ) -> None:
        handler.send_response(status)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    def serve_userinfo(self, **claims: Any) -> None:
        """Answer UserInfo with these claims, the way a provider holding them would"""
        self.userinfo_response = (200, "application/json", json.dumps(claims).encode())

    def serve_userinfo_raw(self, status: int, content_type: str, body: bytes) -> None:
        """Answer UserInfo with a body of our choosing, for the shapes providers get wrong"""
        self.userinfo_response = (status, content_type, body)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def mint(self, kid: str = "key-1", **overrides: Any) -> str:
        """Issue a signed access token, with claim overrides applied last"""
        now = datetime.now(UTC)
        claims: dict[str, Any] = {
            "iss": self.issuer,
            "sub": DEFAULT_SUBJECT,
            "aud": AUDIENCE,
            "azp": CLIENT_ID,
            "client_id": CLIENT_ID,
            "scope": "openid profile email",
            "preferred_username": "lecturer",
            "iat": now,
            "exp": now + timedelta(minutes=5),
        }
        claims.update(overrides)
        claims = {name: value for name, value in claims.items() if value is not None}

        private_key, _ = self.keys[kid]
        return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": kid})


# --- driving the endpoints -------------------------------------------------


def chunk_url(recording: str, track: str = "stream", index: int | str = 0) -> str:
    """Where a chunk is uploaded to, with the names percent-encoded the way the frontend does."""
    return (
        f"/api/recordings/{quote(recording, safe='')}"
        f"/tracks/{quote(track, safe='')}/chunks/{quote(str(index), safe='')}"
    )


def upload(
    client: TestClient,
    token: str | None,
    index: int = 0,
    recording: str = "foo",
    content: bytes = b"payload",
):
    """Upload one chunk of a recording ("foo" unless told otherwise), with or without a token."""
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return client.put(chunk_url(recording, "stream", index), headers=headers, content=content)


def upload_chunk_path(base_dir: Path, user_segment: str, index: int = 0) -> Path:
    """Where `upload` puts its chunk, given the directory it is filed under."""
    return base_dir / user_segment / "foo" / "stream" / f"chunk.{index:04d}"


def finish_recording(
    user_home: Path | anyio.Path, recording: str, content: bytes = b"video"
) -> None:
    """A recording whose postprocessing ran to completion."""
    recording_dir = Path(user_home) / recording
    recording_dir.mkdir(parents=True, exist_ok=True)
    (recording_dir / "presentation.webm").write_bytes(content)


MINUTE = 60


def age(path: Path, seconds: float) -> None:
    """Backdate a file's modification time, which is what the staleness check reads."""
    then = time.time() - seconds
    os.utime(path, (then, then))


def write_chunks(
    recording_dir: Path | anyio.Path, ages: list[float], track: str = "stream"
) -> None:
    """One chunk per entry, chunk.0000 first, each last written `age` seconds ago."""
    track_dir = Path(recording_dir) / track
    track_dir.mkdir(parents=True, exist_ok=True)

    for index, seconds in enumerate(ages):
        chunk = track_dir / f"chunk.{index:04d}"
        chunk.write_bytes(b"chunk")
        age(chunk, seconds)


def abandon_recording(user_home: Path | anyio.Path, recording: str, minutes: float = 30) -> Path:
    """A recording whose last chunk arrived long enough ago that nobody is streaming it."""
    recording_dir = Path(user_home) / recording
    write_chunks(recording_dir, [(minutes + 2) * MINUTE, (minutes + 1) * MINUTE, minutes * MINUTE])
    return recording_dir


def list_recordings(client: TestClient, token: str | None):
    """Ask for the caller's recordings, with or without a token."""
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return client.get("/api/recordings", headers=headers)


def entries(listing: list[dict[str, Any]], state: str) -> list[dict[str, Any]]:
    """The recordings of a listing in one state, in the order the server sent them."""
    return [entry for entry in listing if entry["state"] == state]


def names(listing: list[dict[str, Any]], state: str) -> list[str]:
    """The names of a listing's recordings in one state, in the order the server sent them."""
    return [entry["name"] for entry in entries(listing, state)]


def download_parts(entry: dict[str, Any]) -> tuple[str, str, str]:
    """The user digest, recording name and OTP a listed download link carries, decoded."""
    download_url = entry["downloadUrl"]
    assert isinstance(download_url, str)
    link = urlsplit(download_url)
    _downloads, user_digest, recording = (unquote(part) for part in link.path.split("/"))
    return user_digest, recording, parse_qs(link.query)["totp"][0]


def follow_download(client: TestClient, entry: dict[str, Any]):
    """
    Follow a listed recording's download link, as the browser does when the lecturer clicks it.

    The link is relative to the API root, and the frontend resolves it against the API base it
    already knows; so does this.
    """
    return client.get(urljoin("/api/", entry["downloadUrl"]))


def app_of(client: TestClient) -> FastAPI:
    """The application behind a client, typed -- TestClient only promises an ASGI app."""
    return client.app  # type: ignore[return-value]


def enclave_of(client: TestClient, user_home: Path | anyio.Path) -> Enclave:
    """
    The enclave whose recordings live in `user_home`, filed where the server looks for it, and
    made here if no request has made it yet.

    An authenticated deployment files each enclave under the digest that names its home
    directory, which is also what the download links carry; an open one has a single enclave,
    filed under None. Restated here for the same reason as the directory scheme below.

    One made here skips what the server does on a user's first request: preparing the home
    directory and the alias that names it. A test that needs the alias makes a request first.
    """
    app = app_of(client)
    settings: Settings = app.dependency_overrides[get_settings]()
    key = user_home.name if settings.auth_required else None
    enclaves: dict[str | None, Enclave] = app.state.enclaves

    return enclaves.setdefault(key, Enclave(key, anyio.Path(user_home)))


def activity_of(
    client: TestClient, user_home: Path | anyio.Path, recording: str
) -> RecordingActivity:
    """What, if anything, has claimed one of `user_home`'s recordings right now."""
    return enclave_of(client, user_home).activity(recording)


def job_in_flight(
    client: TestClient, user_home: Path | anyio.Path, recording: str
) -> AbstractContextManager[None]:
    """
    Hold a render claim on one of `user_home`'s recordings, as a job in flight does.

    A TestClient runs background tasks to completion before it returns, so a test that wants
    to catch a job mid-flight holds the claim itself for as long as the `with` lasts.
    """
    return enclave_of(client, user_home).claim_rendering(recording)


def purge_in_flight(
    client: TestClient, user_home: Path | anyio.Path, recording: str
) -> AbstractContextManager[None]:
    """Hold a purge claim on one of `user_home`'s recordings, as a purge in flight does."""
    return enclave_of(client, user_home).claim_purging(recording)


def otp_generator_of(
    client: TestClient, user_home: Path | anyio.Path, recording: str
) -> pyotp.TOTP:
    """
    The generator behind the OTPs in a recording's download links.

    The one place the tests reach into an enclave: an OTP from another interval than the
    current one is what the interval tests need, and nothing public hands one out.
    """
    enclave = enclave_of(client, user_home)
    return enclave._download_totp.factories[recording]  # pyright: ignore[reportPrivateUsage]  # pylint: disable=protected-access


def purge(client: TestClient, token: str | None, recording: str):
    """Ask for a recording to be deleted, as the Purge dialog does once it is confirmed."""
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return client.delete(f"/api/recordings/{quote(recording, safe='')}", headers=headers)


def download_completed(client: TestClient, user_digest: str, recording: str, totp: str | None):
    """Follow a download link put together by hand, for the links no listing hands out."""
    params = {"totp": totp} if totp is not None else None
    return client.get(f"/api/downloads/{user_digest}/{quote(recording, safe='')}", params=params)


# --- the directory scheme, restated ----------------------------------------


def digest_of(subject: str) -> str:
    """The stable directory name user_home.py derives from a subject."""
    return hashlib.sha3_256(subject.encode("utf-8")).hexdigest()


def alias_of(username: str, subject_digest: str) -> str:
    """The readable symlink user_home.py puts beside the stable directory."""
    return f"{username}-{subject_digest[:12]}"


def home_entries(base_dir: Path | anyio.Path) -> set[str]:
    """
    Everything user_home.py has put in the destination root.

    The interesting assertion is usually that there is nothing here beyond the digest --
    a name derived from an untrustworthy username is what these tests are about -- so this
    looks at the whole directory rather than at one expected path.
    """
    return {entry.name for entry in Path(base_dir).iterdir()}


DEFAULT_SUBJECT_DIGEST = digest_of(DEFAULT_SUBJECT)
