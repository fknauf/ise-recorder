"""
The pieces shared by every test module that drives an authenticated backend.

`conftest.py` turns most of this into fixtures; what stays here is what a test file has to
name directly -- the Provider type in a signature, and the small functions that spell out
what the server does with a token, so an assertion can say what it expects instead of
recomputing it.

The naming helpers deliberately restate auth.py's scheme rather than importing it: a test
that derived the expected directory name from the code under test would agree with any
change to it, including the ones that would move a lecturer's recordings.
"""

# pylint: disable=line-too-long
# pylint: disable=missing-class-docstring
# pylint: disable=missing-function-docstring
# pylint: disable=too-many-instance-attributes

from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import threading
from typing import Any
from urllib.parse import quote

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
import jwt

CLIENT_ID = "ise-recorder"
# Distinct from CLIENT_ID on purpose, and that is the normal deployment: an OIDC ID token's
# `aud` is the client id, an access token's names the resource server, so a backend with an
# audience of its own never sees an ID token pass. compose-with-auth.yml configures exactly
# this pair. Only the test that is about a provider collapsing the two sets them equal.
AUDIENCE = "ise-recorder-api"
DEFAULT_SUBJECT = "b472c41f9b227e6596e921541f46dc9d7"


def make_key(kid: str) -> tuple[rsa.RSAPrivateKey, dict[str, Any]]:
    """ Generate an RSA key pair and the JWK describing its public half """
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key(), as_dict=True) # pyright: ignore[reportUnknownVariableType, reportUnknownMemberType, reportAttributeAccessIssue]
    jwk.update({"kid": kid, "use": "sig", "alg": "RS256"}) # pyright: ignore[reportUnknownMemberType]
    return private_key, jwk # pyright: ignore[reportUnknownVariableType]


class Provider:
    """ A stand-in OpenID provider serving discovery and JWKS documents over HTTP """

    def __init__(self) -> None:
        self.keys: dict[str, tuple[rsa.RSAPrivateKey, dict[str, Any]]] = {}
        self.jwks_available = True
        self.jwks_fetch_count = 0
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
        self.keys[kid] = make_key(kid)

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
                    if not provider.jwks_available:
                        self.send_response(503)
                        self.end_headers()
                        return None
                    return provider.respond(self, {
                        "keys": [jwk for _, jwk in provider.keys.values()]
                    })

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
            target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
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
        """ Answer UserInfo with these claims, the way a provider holding them would """
        self.userinfo_response = (200, "application/json", json.dumps(claims).encode())

    def serve_userinfo_raw(self, status: int, content_type: str, body: bytes) -> None:
        """ Answer UserInfo with a body of our choosing, for the shapes providers get wrong """
        self.userinfo_response = (status, content_type, body)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def mint(self, kid: str = "key-1", **overrides: Any) -> str:
        """ Issue a signed access token, with claim overrides applied last """
        now = datetime.now(timezone.utc)
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

def upload(client: TestClient, token: str | None, index: int = 0):
    """ Upload one chunk of the recording "foo", with or without a token. """
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return client.post(
        "/api/chunks",
        headers=headers,
        data={"recording": "foo", "track": "stream", "index": str(index)},
        files={"chunk": b"payload"},
    )


def upload_chunk_path(base_dir: Path, user_segment: str, index: int = 0) -> Path:
    """ Where `upload` puts its chunk, given the directory it is filed under. """
    return base_dir / user_segment / "foo" / "stream" / f"chunk.{index:04d}"


def finish_recording(user_home: Path, recording: str, content: bytes = b"video") -> None:
    """ A recording whose postprocessing ran to completion. """
    (user_home / recording).mkdir(parents=True, exist_ok=True)
    (user_home / recording / "presentation.webm").write_bytes(content)


def list_recordings(client: TestClient, token: str | None):
    """ Ask for the caller's completed and rendering recordings, with or without a token. """
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return client.get("/api/recordings", headers=headers)


def download_completed(client: TestClient, user_digest: str, recording: str, totp: str | None):
    """ Follow a download link, as the browser would when the lecturer clicks one. """
    params = {"totp": totp} if totp is not None else None
    return client.get(f"/api/recordings/{user_digest}/{quote(recording)}", params=params)


# --- the directory scheme, restated ----------------------------------------

def digest_of(subject: str) -> str:
    """ The stable directory name auth.py derives from a subject. """
    return hashlib.sha3_256(subject.encode("utf-8")).hexdigest()


def alias_of(username: str, subject_digest: str) -> str:
    """ The readable symlink auth.py puts beside the stable directory. """
    return f"{username}-{subject_digest[:12]}"


def home_entries(base_dir: Path) -> set[str]:
    """
    Everything auth.py has put in the destination root.

    The interesting assertion is usually that there is nothing here beyond the digest --
    a name derived from an untrustworthy username is what these tests are about -- so this
    looks at the whole directory rather than at one expected path.
    """
    return {entry.name for entry in base_dir.iterdir()}


DEFAULT_SUBJECT_DIGEST = digest_of(DEFAULT_SUBJECT)
