# pylint: disable=line-too-long
# pylint: disable=missing-class-docstring
# pylint: disable=missing-function-docstring
# pylint: disable=missing-module-docstring
# pylint: disable=redefined-outer-name

from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
import threading
from typing import Any, Iterator, Optional

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
import jwt
import pytest

from ise_record import auth
from ise_record.auth import user_home_dir
from ise_record.server import create_app
from ise_record.settings import OidcSettings, SAFE_NAME_REGEX, Settings

CLIENT_ID = "ise-recorder"


def make_key(kid: str) -> tuple[rsa.RSAPrivateKey, dict[str, Any]]:
    """ Generate an RSA keypair and the JWK describing its public half """
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
        self.signing_algorithms: list[Any] = ["RS256"]
        self._server: Optional[HTTPServer] = None
        self._thread: Optional[threading.Thread] = None

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
                    return provider.respond(self, {
                        "issuer": provider.issuer,
                        "authorization_endpoint": f"{provider.issuer}/authorize",
                        "token_endpoint": f"{provider.issuer}/token",
                        "jwks_uri": f"{provider.issuer}/jwks",
                        "id_token_signing_alg_values_supported": provider.signing_algorithms,
                    })

                if self.path.endswith("/jwks"):
                    provider.jwks_fetch_count += 1
                    if not provider.jwks_available:
                        self.send_response(503)
                        self.end_headers()
                        return None
                    return provider.respond(self, {
                        "keys": [jwk for _, jwk in provider.keys.values()]
                    })

                self.send_response(404)
                self.end_headers()
                return None

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @staticmethod
    def respond(handler: BaseHTTPRequestHandler, body: dict[str, Any]) -> None:
        encoded = json.dumps(body).encode()
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(encoded)))
        handler.end_headers()
        handler.wfile.write(encoded)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def mint(self, kid: str = "key-1", **overrides: Any) -> str:
        """ Issue a signed access token, with claim overrides applied last """
        now = datetime.now(timezone.utc)
        claims: dict[str, Any] = {
            "iss": self.issuer,
            "sub": "b472c41f9b227e6596e921541f46dc9d7",
            "aud": CLIENT_ID,
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


@pytest.fixture
def provider() -> Iterator[Provider]:
    instance = Provider()
    instance.add_key("key-1")
    instance.start()
    yield instance
    instance.stop()


@pytest.fixture
def settings(provider: Provider, tmp_path: Path) -> Settings:
    return Settings(
        destdir=tmp_path,
        oidc=OidcSettings(
            provider_url=provider.issuer,
            audience=CLIENT_ID
        )
    )


@pytest.fixture
def fresh_settings(provider: Provider, tmp_path: Path) -> Settings:
    return Settings(
        destdir=tmp_path / "fresh",
        oidc=OidcSettings(
            provider_url=provider.issuer,
            audience=CLIENT_ID
        )
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def instant_jwks_refresh(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Let an unknown kid refetch the key set immediately, instead of after the cooldown.

    Rotation takes milliseconds here and half a minute in production, so without this a
    rotation test would only be measuring PyJWKClient's rate limit. The cooldown is read
    when the client is constructed, which is when the app starts up -- request this
    fixture ahead of `client` so it is patched by then.
    """
    monkeypatch.setattr(auth, "JWKS_REFRESH_COOLDOWN_SECONDS", 0.0)


def upload(client: TestClient, token: Optional[str], index: int = 0):
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return client.post(
        "/api/chunks",
        headers=headers,
        data={"recording": "foo", "track": "stream", "index": str(index)},
        files={"chunk": b"payload"},
    )


def test_valid_token_is_accepted(client: TestClient, provider: Provider):
    assert upload(client, provider.mint()).status_code == 201


def test_chunk_lands_in_a_per_user_directory(client: TestClient, provider: Provider, tmp_path: Path):
    assert upload(client, provider.mint()).status_code == 201

    chunks = list(tmp_path.rglob("chunk.*"))
    assert len(chunks) == 1
    # readable prefix from preferred_username, digest suffix from sub
    assert chunks[0].relative_to(tmp_path).parts[0].startswith("lecturer-")


def test_different_subjects_get_different_directories(
    client: TestClient, provider: Provider, tmp_path: Path
):
    assert upload(client, provider.mint(sub="user-a"), index=0).status_code == 201
    assert upload(client, provider.mint(sub="user-b"), index=1).status_code == 201

    assert len({path.relative_to(tmp_path).parts[0] for path in tmp_path.rglob("chunk.*")}) == 2


def test_missing_token_is_rejected(client: TestClient):
    response = upload(client, None)
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_garbage_token_is_rejected(client: TestClient):
    assert upload(client, "not-a-jwt").status_code == 401


def test_expired_token_is_rejected(client: TestClient, provider: Provider):
    stale = datetime.now(timezone.utc) - timedelta(hours=1)
    token = provider.mint(iat=stale, exp=stale + timedelta(minutes=5))
    assert upload(client, token).status_code == 401


def test_wrong_issuer_is_rejected(client: TestClient, provider: Provider):
    assert upload(client, provider.mint(iss="https://evil.example.com")).status_code == 401


def test_wrong_audience_is_rejected(client: TestClient, provider: Provider):
    assert upload(client, provider.mint(aud="some-other-app")).status_code == 401


def test_missing_required_claim_is_rejected(client: TestClient, provider: Provider):
    # "scope" separates an access token from an id token, which is otherwise identical
    assert upload(client, provider.mint(scope=None)).status_code == 401


def test_missing_subject_is_rejected(client: TestClient, provider: Provider):
    assert upload(client, provider.mint(sub=None)).status_code == 401


def test_unsigned_token_is_rejected(client: TestClient, provider: Provider):
    claims: dict[str, Any] = {
        "iss": provider.issuer, "sub": "nobody", "aud": CLIENT_ID, "scope": "openid",
        "iat": datetime.now(timezone.utc), "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    forged = jwt.encode(claims, key="", algorithm="none", headers={"kid": "key-1"})
    assert upload(client, forged).status_code == 401


def test_token_signed_by_an_unknown_key_is_rejected(client: TestClient, provider: Provider):
    stranger, _ = make_key("key-1")
    claims: dict[str, Any] = {
        "iss": provider.issuer, "sub": "nobody", "aud": CLIENT_ID, "scope": "openid",
        "iat": datetime.now(timezone.utc), "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
    }
    forged = jwt.encode(claims, stranger, algorithm="RS256", headers={"kid": "key-1"})
    assert upload(client, forged).status_code == 401


def test_unknown_kid_is_rejected(client: TestClient, provider: Provider):
    provider.add_key("key-2")
    token = provider.mint(kid="key-2")
    del provider.keys["key-2"]

    assert upload(client, token).status_code == 401


# --- operational behaviour -------------------------------------------------

def test_rotated_signing_key_is_picked_up_without_restart(
    instant_jwks_refresh: None,  # pylint: disable=unused-argument
    client: TestClient,
    provider: Provider,
):
    assert upload(client, provider.mint(), index=0).status_code == 201

    # The provider rotates: a new key appears and the old one is withdrawn.
    provider.add_key("key-2")
    del provider.keys["key-1"]

    assert upload(client, provider.mint(kid="key-2"), index=1).status_code == 201


def test_unreachable_jwks_reports_service_unavailable(client: TestClient, provider: Provider):
    token = provider.mint()
    provider.jwks_available = False

    assert upload(client, token).status_code == 503


def test_jwks_is_cached_between_requests(client: TestClient, provider: Provider):
    for index in range(4):
        assert upload(client, provider.mint(), index=index).status_code == 201

    assert provider.jwks_fetch_count == 1


def test_unconfigured_deployment_stays_open(tmp_path: Path):
    with TestClient(create_app(Settings(destdir=tmp_path))) as client:
        assert upload(client, None).status_code == 201

    assert (tmp_path / "foo" / "stream" / "chunk.0000").is_file()


# --- directory naming ------------------------------------------------------

SUBJECT_DIGEST = hashlib.sha3_256(b"abc").hexdigest()[:12]


@pytest.mark.parametrize("username,expected_prefix", [
    ("lecturer", "lecturer-"),
    ("m.mustermann", "m.mustermann-"),
    ("a/b", "a_b-"),
    ("mit Leerzeichen", "mit_Leerzeichen-"),
])
def test_readable_username_becomes_the_directory_prefix(username: str, expected_prefix: str):
    name = user_home_dir({"sub": "abc", "preferred_username": username})

    assert name.startswith(expected_prefix)
    assert name.endswith(SUBJECT_DIGEST)


@pytest.mark.parametrize("username", [
    None, 42, "", "...", "---",           # nothing usable to prefix with
    "../../etc/passwd", "..", "./x",      # would not survive as a path segment
    "-rf",                                # leading dash
])
def test_unusable_username_falls_back_to_the_subject_digest(username: Any):
    assert user_home_dir({"sub": "abc", "preferred_username": username}) \
        == SUBJECT_DIGEST


@pytest.mark.parametrize("username", [
    "lecturer", "a/b", "../../etc/passwd", "..", "", "-rf", "\\\\server\\share",
    "a" * 300, "ä ö ü", "nul\x00byte", "%2e%2e%2f", "..;/", 42, None,
])
def test_directory_name_is_always_a_safe_single_path_segment(username: Any):
    name = user_home_dir({"sub": "abc", "preferred_username": username})

    assert re.match(SAFE_NAME_REGEX, name), f"unsafe directory name: {name!r}"
    assert (Path("/data") / name).resolve().parent == Path("/data")


def test_directory_name_is_stable_for_a_subject():
    claims = {"sub": "abc", "preferred_username": "lecturer"}

    assert user_home_dir(claims) == user_home_dir(claims)


def test_username_collisions_are_separated_by_the_digest():
    first = user_home_dir({"sub": "user-a", "preferred_username": "same"})
    second = user_home_dir({"sub": "user-b", "preferred_username": "same"})

    assert first != second


# --- the signing algorithm comes from the key set --------------------------

@pytest.mark.parametrize("advertised", [
    ["none"],
    ["HS256"],
    [],
    None,
])
def test_metadata_algorithm_list_is_not_consulted(
    client: TestClient, provider: Provider, advertised: Any
):
    # Whatever the discovery document claims, the key set decides. A provider advertising
    # nothing usable for id tokens must not stop valid access tokens being verified.
    provider.signing_algorithms = advertised

    assert upload(client, provider.mint()).status_code == 201


def test_key_without_an_alg_member_still_verifies(client: TestClient, provider: Provider):
    # RFC 7517 makes "alg" optional; PyJWT infers RS256 from kty=RSA.
    del provider.keys["key-1"][1]["alg"]

    assert upload(client, provider.mint()).status_code == 201


def test_key_claiming_an_insecure_algorithm_is_refused(
    client: TestClient, provider: Provider, fresh_settings: Settings
):
    # Prime the cache with the real key, then have the provider serve a symmetric key under
    # the same kid. PyJWK would bind HS256 to it; the denylist must refuse it.
    assert upload(client, provider.mint(), index=0).status_code == 201

    # The served key is the one the token below is signed with, so the only thing standing
    # between the forgery and a 201 is the denylist. A mismatched key would make this test
    # pass on a plain signature failure and say nothing about the denylist at all. 32 bytes,
    # because PyJWT warns about shorter HMAC keys and we do not want the warning to be the
    # reason this is refused either.
    provider.keys["key-1"][1].clear()
    provider.keys["key-1"][1].update(
        {
            "kty": "oct",
            "alg": "HS256",
            "k": "bEM2SVVab2FrdGVwNnFQY2JKTE5oUTFqaU9WbEFxS1k",
            "kid": "key-1",
            "use": "sig"
        }
    )
    forged = jwt.encode(
        {
            "iss": provider.issuer, "sub": "nobody", "aud": CLIENT_ID, "scope": "openid",
            "iat": datetime.now(timezone.utc),
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        },
        "lC6IUZoaktep6qPcbJLNhQ1jiOVlAqKY", algorithm="HS256", headers={"kid": "key-1"},
    )

    # A fresh app, so the poisoned key set is fetched rather than read from the cache.
    with TestClient(create_app(fresh_settings)) as fresh:
        assert upload(fresh, forged).status_code == 401
